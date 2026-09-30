// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * shims/npm-bridges-pi-ai.js — the pi-ai bridge rows (loader shadows,
 * provider catalogs, the composed providers/all barrel) and their JSON seam
 * tables, split from npm-bridges.js at the size budget.
 */

export const PI_AI_DIST = '/vendor/npm/@earendil-works/pi-ai@0.85.1/dist';
// id → provider-file export name, MEASURED verbatim against the vendored
// all.js import block (2026-09-28) — the generated names are NOT a uniform
// camelCase of the id (azure-openai-responses → azureOpenAIResponsesProvider
// but openai-codex → openaiCodexProvider; cloudflare-ai-gateway →
// cloudflareAIGatewayProvider), so no derivation rule survives the pin; a
// pin move fails LOUD here (a missing export names itself).
export const PI_AI_PROVIDER_EXPORTS = {
  'amazon-bedrock': 'amazonBedrockProvider',
  'ant-ling': 'antLingProvider',
  'anthropic': 'anthropicProvider',
  'azure-openai-responses': 'azureOpenAIResponsesProvider',
  'baseten': 'basetenProvider',
  'cerebras': 'cerebrasProvider',
  'cloudflare-ai-gateway': 'cloudflareAIGatewayProvider',
  'cloudflare-workers-ai': 'cloudflareWorkersAIProvider',
  'deepseek': 'deepseekProvider',
  'fireworks': 'fireworksProvider',
  'github-copilot': 'githubCopilotProvider',
  'google': 'googleProvider',
  'google-vertex': 'googleVertexProvider',
  'groq': 'groqProvider',
  'huggingface': 'huggingfaceProvider',
  'kimi-coding': 'kimiCodingProvider',
  'minimax': 'minimaxProvider',
  'minimax-cn': 'minimaxCnProvider',
  'mistral': 'mistralProvider',
  'moonshotai': 'moonshotaiProvider',
  'moonshotai-cn': 'moonshotaiCnProvider',
  'nvidia': 'nvidiaProvider',
  'openai': 'openaiProvider',
  'openai-codex': 'openaiCodexProvider',
  'opencode': 'opencodeProvider',
  'opencode-go': 'opencodeGoProvider',
  'openrouter': 'openrouterProvider',
  'openrouter-images': 'openrouterImagesProvider',
  'qwen-token-plan': 'qwenTokenPlanProvider',
  'qwen-token-plan-cn': 'qwenTokenPlanCnProvider',
  'qwen-token-plan-individual': 'qwenTokenPlanIndividualProvider',
  'radius': 'radiusProvider',
  'together': 'togetherProvider',
  'vercel-ai-gateway': 'vercelAIGatewayProvider',
  'xai': 'xaiProvider',
  'xiaomi': 'xiaomiProvider',
  'xiaomi-token-plan-ams': 'xiaomiTokenPlanAmsProvider',
  'xiaomi-token-plan-cn': 'xiaomiTokenPlanCnProvider',
  'xiaomi-token-plan-sgp': 'xiaomiTokenPlanSgpProvider',
  'zai': 'zaiProvider',
  'zai-coding-cn': 'zaiCodingCnProvider',
};
const piAiUpperSnake = (id) => `${id.toUpperCase().replace(/-/g, '_')}_MODELS`;
// The manifest read with the packer fallback (the composed barrel in
// npm-bridges-pi-ai-all.js reads it the same way): the
// literal dot name on the desktop/iOS embeds, the staged non-hidden alias
// where the HAP/APK packers dropped the hidden file.
const piAiManifestText = (() => {
  try {
    return globalThis.__dshBundleRequire(
      `${PI_AI_DIST}/providers/all.js`, './data/.manifest.json');
  } catch {
    return globalThis.__dshBundleRequire(
      `${PI_AI_DIST}/providers/all.js`, './data/manifest.json');
  }
})();
export const PI_AI_PROVIDER_IDS = Object.keys(JSON.parse(piAiManifestText)
  .files).map((file) => file.replace(/\.json$/, ''));

/** Loader-shadow modules for the 39 unparseable generated .models.js files.
 * TWO names per file: the absolute vendor path AND the bundle-relative one
 * — dsh_resolve_relative tokenizes a slash-prefixed importer directory into
 * a leading EMPTY segment, so its join produces the NO-slash spelling; relative re-entry never carries the slash. */
export const PI_AI_MODEL_SHADOWS = PI_AI_PROVIDER_IDS.flatMap((id) => {
  const source = [
    `import { flattenModelCatalog } from '${PI_AI_DIST}/model-catalog.js';`,
    `const values = JSON.parse(globalThis.__dshBundleRequire(`,
    `    '${PI_AI_DIST}/providers/models.js', './data/${id}.json'));`,
    `export const ${piAiUpperSnake(id)} = flattenModelCatalog('${id}', values);`,
  ].join('\n');
  return [
    [`${PI_AI_DIST}/providers/${id}.models.js`, source],
    [`${PI_AI_DIST.slice(1)}/providers/${id}.models.js`, source],
  ];
});
