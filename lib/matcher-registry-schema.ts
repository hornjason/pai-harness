import { z } from "zod";

const MatcherPatternSchema = z.object({
  name: z.string().min(1),
  syntax: z.string().min(1),
  regex: z.string().min(1).refine(
    (val) => {
      try {
        new RegExp(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid regular expression" }
  ),
  example: z.string().min(1),
  notes: z.string().min(1),
});

const MatcherRegistrySchema = z.object({
  patterns: z.array(MatcherPatternSchema).min(1),
});

export type MatcherPattern = z.infer<typeof MatcherPatternSchema>;
export type MatcherRegistry = z.infer<typeof MatcherRegistrySchema>;

export function parseMatcherRegistry(raw: unknown): MatcherRegistry {
  return MatcherRegistrySchema.parse(raw);
}

export function safeParseMatcherRegistry(raw: unknown) {
  return MatcherRegistrySchema.safeParse(raw);
}
