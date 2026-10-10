import { consumeResponsesStream } from "../../../services/responses-stream-consumer";
import { describe, expect, test } from "bun:test";
import { createGatewayProxyStreamSelector, selectGatewayProxyResponse } from "./runtime-proxy";
import type { JsonObject } from "./schemas";

const citation = { type: "url_citation", url: "https://example.org/source", title: "Source", start_index: 0, end_index: 7 };
const variants: JsonObject[] = [citation,
  { type: "file_citation", file_id: "file_fixture", filename: "notes.txt", index: 0 },
  { type: "container_file_citation", container_id: "container_fixture", file_id: "file_fixture", filename: "notes.txt", start_index: 0, end_index: 7 },
  { type: "file_path", file_id: "file_fixture", index: 0 },
];

function fixture(phase?: string, annotationEvents = true, annotations: JsonObject[] = [citation]) {
  const content = [{ type: "output_text", text: "Fixture 🌍", annotations }];
  const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", ...(phase ? { phase } : {}), content };
  return [
    { type: "response.created", response: { id: "resp_fixture", model: "upstream", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "Fixture 🌍" },
    ...(annotationEvents ? annotations.map((annotation, annotation_index) => ({ type: "response.output_text.annotation.added", output_index: 0, content_index: 0, annotation_index, item_id: item.id, annotation })) : []),
    { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: content[0]!.text },
    { type: "response.content_part.done", output_index: 0, content_index: 0, item_id: item.id, part: content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_fixture", model: "upstream", status: "completed", output: [item], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } },
  ].map(event => structuredClone(event)) as JsonObject[];
}

function replay(data: JsonObject[], targetFormat: "responses" | "messages" | "chat-completions" | "google-generate-content" = "responses") {
  const selector = createGatewayProxyStreamSelector({ sourceFormat: "responses", targetFormat, model: "public", requestId: "ptrreq_annotations_fixture" });
  const lines = data.flatMap(event => selector.push({ event: String(event.type), data: event }).lines);
  lines.push(...selector.finish().lines);
  const events = lines.flatMap(line => {
    const body = line.split("data: ")[1];
    if (!body || body.trim() === "[DONE]") return [];
    return [JSON.parse(body)];
  });
  return { selector, events };
}

describe("Responses citation stream contract", () => {
  for (const phase of [undefined, "commentary", "final_answer"]) {
    for (const annotationEvents of [true, false]) {
      test(`${phase ?? "ordinary"} retains citations with ${annotationEvents ? "incremental" : "completed-only"} metadata`, () => {
        const data = fixture(phase, annotationEvents, variants);
        const { selector, events } = replay(data);
        expect(selector.failed()).toBe(false);
        expect(selector.ended()).toBe(true);
        expect(events.filter(event => event.type === "response.completed")).toHaveLength(1);
        expect(events.filter(event => event.type === "response.output_text.annotation.added")).toHaveLength(annotationEvents ? variants.length : 0);
        const part = events.find(event => event.type === "response.content_part.done").part;
        const item = events.find(event => event.type === "response.output_item.done").item;
        const terminal = events.find(event => event.type === "response.completed").response;
        expect(part.annotations).toEqual(variants);
        expect(item.content[0]).toEqual(part);
        expect(terminal.output).toEqual([item]);
        expect(terminal.usage.total_tokens).toBe(5);
        expect(events.map(event => event.sequence_number)).toEqual(events.map((_, index) => index));
        const nonstream = selectGatewayProxyResponse({ sourceFormat: "responses", targetFormat: "responses", model: "public", payload: (data.at(-1) as any).response });
        expect(nonstream.ok).toBe(true);
        if (nonstream.ok) expect(nonstream.response.output).toEqual(terminal.output);
      });
    }
  }

  test("buffered native output preserves sparse-terminal citations and metadata", async () => {
    const data = fixture();
    const terminal = (data.at(-1) as any).response;
    terminal.output = [];
    terminal.created_at = 100;
    terminal.instructions = "fixture instructions";
    terminal.reasoning = {effort:"low",summary:null};
    const wire = data.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const buffered = await consumeResponsesStream(new Response(wire), "fixture");
    expect((buffered.output as any)[0].content[0].annotations).toEqual([citation]);
    expect(buffered.created_at).toBe(100);
    expect(buffered.instructions).toBe("fixture instructions");
    expect(buffered.reasoning).toEqual(terminal.reasoning);
    const stream = replay(data);
    expect(stream.events.at(-1).response.output).toEqual(buffered.output);
    expect(stream.events.at(-1).response.created_at).toBe(100);
  });

  test("ordinary refusal keeps its distinct content and terminal", () => {
    const part = {type:"refusal",refusal:"Fixture cannot complete that request."};
    const item = {type:"message",id:"msg_refusal",role:"assistant",status:"completed",content:[part]};
    const data:JsonObject[] = [
      {type:"response.created",response:{id:"resp_refusal",model:"upstream"}},
      {type:"response.output_item.added",output_index:0,item:{...item,content:[]}},
      {type:"response.content_part.added",output_index:0,content_index:0,item_id:item.id,part:{type:"refusal",refusal:""}},
      {type:"response.refusal.delta",output_index:0,content_index:0,item_id:item.id,delta:part.refusal},
      {type:"response.refusal.done",output_index:0,content_index:0,item_id:item.id,refusal:part.refusal},
      {type:"response.content_part.done",output_index:0,content_index:0,item_id:item.id,part},
      {type:"response.output_item.done",output_index:0,item},
      {type:"response.completed",response:{id:"resp_refusal",model:"upstream",status:"completed",output:[item]}},
    ];
    const {selector,events}=replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.at(-1).response.output[0].content).toEqual([part]);
  });

  test("multiple messages and content indices remain separate", () => {
    const parts = ["First", "Second 🌍"].map(text => ({ type: "output_text", text, annotations: [citation] }));
    const items = [0, 1].map(index => ({ type: "message", id: `msg_${index}`, role: "assistant", status: "completed", content: parts }));
    const data: JsonObject[] = [{ type: "response.created", response: { id: "resp_multi", model: "upstream" } }];
    for (const [output_index, item] of items.entries()) {
      data.push({ type: "response.output_item.added", output_index, item: { ...item, content: [], status: "in_progress" } });
      for (const [content_index, part] of parts.entries()) data.push(
        { type: "response.content_part.added", output_index, content_index, item_id: item.id, part: { ...part, text: "", annotations: [] } },
        { type: "response.output_text.delta", output_index, content_index, item_id: item.id, delta: part.text },
        { type: "response.output_text.annotation.added", output_index, content_index, item_id: item.id, annotation_index: 0, annotation: citation },
        { type: "response.content_part.done", output_index, content_index, item_id: item.id, part },
      );
      data.push({ type: "response.output_item.done", output_index, item });
    }
    data.push({ type: "response.completed", response: { id: "resp_multi", model: "upstream", status: "completed", output: items } });
    const { selector, events } = replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.find(event => event.type === "response.completed").response.output).toEqual(items);
    expect(events.filter(event => event.type === "response.output_text.delta").map(event => [event.output_index, event.content_index, event.delta])).toEqual([[0, 0, "First"], [0, 1, "Second 🌍"], [1, 0, "First"], [1, 1, "Second 🌍"]]);
  });

  test("nullable annotation events survive without inventing a citation", () => {
    const data = fixture(undefined, false, []);
    data.splice(4, 0, { type: "response.output_text.annotation.added", item_id: "msg_fixture", output_index: 0, content_index: 0, annotation_index: 0, annotation: null });
    const { selector, events } = replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.find(event => event.type === "response.output_text.annotation.added").annotation).toBeNull();
    expect(events.find(event => event.type === "response.completed").response.output[0].content[0].annotations).toEqual([]);
  });

  test("terminal-only annotations are preserved", () => {
    const data = fixture(undefined, false, []);
    (data.at(-1) as any).response.output[0].content[0].annotations = [citation];
    const { selector, events } = replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.find(event => event.type === "response.completed").response.output[0].content[0].annotations).toEqual([citation]);
  });

  for (const invalid of [{ item_id: "wrong" }, { content_index: -1 }, { annotation_index: 0.5 }, { annotation: { ...citation, end_index: "wrong" } }]) {
    test(`malformed annotation fails without successful completion: ${JSON.stringify(invalid)}`, () => {
      const data = fixture();
      Object.assign(data.find(event => event.type === "response.output_text.annotation.added")!, invalid);
      const { selector, events } = replay(data);
      expect(selector.failed()).toBe(true);
      expect(events.some(event => event.type === "response.completed")).toBe(false);
    });
  }

  test("dropping a citation from a completed snapshot is detected", () => {
    const data = fixture();
    (data.find(event => event.type === "response.output_item.done") as any).item.content = [{ type: "output_text", text: "Fixture 🌍", annotations: [] }];
    expect(replay(data).selector.failed()).toBe(true);
  });

  test("item-only metadata cannot disappear from the terminal snapshot", () => {
    const data = fixture(undefined, false, []);
    (data.find(event => event.type === "response.output_item.done") as any).item.content[0].annotations = [citation];
    expect(replay(data).selector.failed()).toBe(true);
  });

  test("sparse terminal output retains the independently completed message", () => {
    const data = fixture();
    (data.at(-1) as any).response.output = [];
    const {selector, events} = replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.at(-1).response.output[0].content[0].annotations).toEqual([citation]);
  });

  test("a provider failure with empty output stays a provider failure", () => {
    const data = fixture().slice(0, 5);
    data.push({ type: "response.failed", response: { id: "resp_fixture", status: "failed", output: [], error: { code: "server_error", message: "Synthetic upstream failure" } } });
    const { selector, events } = replay(data);
    expect(selector.failure()?.kind).not.toBe("translation");
    expect(selector.upstreamFailed()).toBe(true);
    expect(events.at(-1).type).toBe("error");
    expect(events.at(-1).code).toBe("pointer_upstream_unavailable");
  });

  test("annotated EOF stays interrupted", () => {
    const { selector, events } = replay(fixture().slice(0, -1));
    expect(selector.failed()).toBe(true);
    expect(selector.failure()?.kind).toBe("interrupted");
    expect(events.some(event => event.type === "response.completed")).toBe(false);
  });

  test("genuine incomplete outcome is retained", () => {
    const data = fixture();
    data[data.length - 1] = { type: "response.incomplete", response: { id: "resp_fixture", model: "upstream", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
    const { selector, events } = replay(data);
    expect(selector.failed()).toBe(false);
    expect(events.at(-1).type).toBe("response.incomplete");
    expect(events.some(event => event.type === "response.completed")).toBe(false);
  });

  for (const target of ["messages", "chat-completions", "google-generate-content"] as const) {
    test(`ordinary text still translates to ${target} while citations cannot silently disappear`, () => {
      expect(replay(fixture(undefined, false, []), target).selector.failed()).toBe(false);
      expect(replay(fixture(), target).selector.failed()).toBe(true);
    });
  }
});
