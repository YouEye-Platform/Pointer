export interface GroupSummary {
  id: string;
  name: string;
  isDefault: boolean;
  position: number;
  entryCount: number;
  enabledEntryCount: number;
  previewEntries: GroupEntry[];
  createdAt: string;
}

export interface GroupEntry {
  id: string;
  groupId: string;
  catalogEntityId: string | null;
  providerModelKey: string | null;
  modelId: string;
  modelName: string;
  displayName?: string;
  modelSlug: string | null;
  modelIconKey: string | null;
  creator: string | null;
  providerId: string;
  providerAccountId: string | null;
  providerAccountNickname: string | null;
  providerName: string;
  providerIconKey: string | null;
  rawModelId: string;
  alias: string | null;
  enabled: boolean;
  position: number;
  hiddenAliases: string[];
  providerAvailable: boolean;
  needsReview: boolean;
  inputPrice: string | null;
  outputPrice: string | null;
  contextWindow: number | null;
  maxOutput: number | null;
}

export interface GroupDetail extends Omit<GroupSummary, "entryCount" | "enabledEntryCount" | "previewEntries"> {
  entries: GroupEntry[];
}
