export function catalogSortDirection(sort: string, requestedOrder?: string): 1 | -1 {
  if (requestedOrder === "desc") return -1;
  if (requestedOrder === "asc") return 1;
  return sort === "newest" || sort.startsWith("benchmark:") ? -1 : 1;
}
