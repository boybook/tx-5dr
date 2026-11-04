import { z } from 'zod';

type PatchShape<Shape extends Record<string, z.ZodType>> = {
  [Key in keyof Shape]: z.ZodOptional<z.ZodType<z.output<Shape[Key]>, z.input<Shape[Key]>>>;
};

/** A configuration patch validates supplied values without defaulting absent fields. */
export function configPatchSchema<Shape extends Record<string, z.ZodType>>(schema: z.ZodObject<Shape>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => {
    // Zod 4 applies defaults even inside optional fields. Keep creation defaults
    // on the configuration schema, and remove only the patch field's wrappers.
    while (field instanceof z.ZodDefault || field instanceof z.ZodPrefault || field instanceof z.ZodOptional) {
      field = field.unwrap() as z.ZodType;
    }
    return [key, field.optional()];
  })) as PatchShape<Shape>;
  return z.object(shape);
}
