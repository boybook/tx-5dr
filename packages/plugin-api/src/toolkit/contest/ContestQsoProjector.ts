export interface ContestProjectionAdapter<TRecord, TProjected> {
  project(record: TRecord): TProjected | null;
  identity(projected: TProjected): string;
  dupeKey(projected: TProjected): string;
}

export interface ContestProjectedRow<TProjected> {
  record: TProjected;
  identity: string;
  dupe: boolean;
}

export function projectContestRecords<TRecord, TProjected>(
  records: readonly TRecord[],
  adapter: ContestProjectionAdapter<TRecord, TProjected>,
): ContestProjectedRow<TProjected>[] {
  const worked = new Set<string>();
  return records.flatMap((record) => {
    const projected = adapter.project(record);
    if (!projected) return [];
    const key = adapter.dupeKey(projected);
    const dupe = worked.has(key);
    worked.add(key);
    return [{ record: projected, identity: adapter.identity(projected), dupe }];
  });
}
