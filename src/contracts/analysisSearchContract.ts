import { z } from "zod";
import { nulFreeStringSchema } from "../domain/localPath.js";

/** Shared provider search input fields. */
export const analysisSearchInput = {
  pattern: nulFreeStringSchema
    .min(1)
    .describe("The literal text or regex pattern to search for"),
  mode: z.enum(["literal", "regex"]).default("literal"),
  case_sensitive: z.boolean().default(false).describe("Whether to match case"),
  document: nulFreeStringSchema.min(1).optional().describe("The document name"),
};
