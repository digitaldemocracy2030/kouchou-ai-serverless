import type { ExtractedArgument, Project } from "../../types/project";
import type { EndpointConfig } from "../../types/settings";
import { fnv1a } from "./clusterTable";

export const cacheKey = (...values: unknown[]) => fnv1a(JSON.stringify(values));
export const chatCacheKey = (endpoint: EndpointConfig) => [
  endpoint.baseUrl,
  endpoint.model,
  endpoint.reasoningEffort,
  endpoint.serviceTier,
];
export const extractionCacheKey = (project: Project) =>
  cacheKey(
    "answer-scoped-v2",
    project.comments,
    project.prompts.extraction,
    chatCacheKey(project.settingsSnapshot.chat),
  );
export const embeddingCacheKey = (args: ExtractedArgument[], endpoint: EndpointConfig) =>
  cacheKey(args, endpoint.baseUrl, endpoint.model);
