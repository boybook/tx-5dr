export interface ContestCategoryField {
  id: string;
  values: readonly string[];
  required?: boolean;
}

export interface ContestCategoryDefinition<TConfig> {
  fields: readonly ContestCategoryField[];
  validate(config: TConfig): readonly string[];
}

export function assertContestCategory<TConfig>(
  definition: ContestCategoryDefinition<TConfig>,
  config: TConfig,
): void {
  const errors = definition.validate(config);
  if (errors.length > 0) throw new Error(`contest_category_invalid:${errors.join(',')}`);
}
