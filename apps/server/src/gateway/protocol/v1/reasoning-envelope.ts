import {irReasoningBlockSchema,type IrContentBlock} from './schemas';
import type {GatewayApiFormat} from '../../compatibility';

const PREFIX='pointer:reasoning:v1:';
type Reasoning=Extract<IrContentBlock,{type:'reasoning'}>;

// Native clients retain redacted_thinking.data as opaque state. Preserve the
// original protocol and complete reasoning item inside that opaque carrier;
// never interpret/decrypt provider ciphertext or fabricate source signatures.
export function encodeReasoningEnvelope(block:Reasoning,source:GatewayApiFormat):string {
  return PREFIX+Buffer.from(JSON.stringify({...block,encryptedSourceFormat:block.encryptedSourceFormat??source})).toString('base64url');
}
export function decodeReasoningEnvelope(data:string):Reasoning|null {
  if(!data.startsWith(PREFIX))return null;
  const encoded=data.slice(PREFIX.length);
  if(!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error('Invalid reasoning envelope');
  const block=irReasoningBlockSchema.parse(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')));
  if(!block.encryptedContent||!block.encryptedSourceFormat)throw new Error('Invalid reasoning envelope');
  return block;
}
