export interface TextEmbeddingService {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export type OpenAiEmbeddingOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
};

export type EmbeddingFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function endpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/embeddings") ? base : `${base}/embeddings`;
}

/** OpenAI-compatible embeddings client. Configure baseUrl with its API prefix, e.g. http://host:port/v1. */
export class OpenAiCompatibleEmbeddingService implements TextEmbeddingService {
  constructor(private readonly options: OpenAiEmbeddingOptions, private readonly fetchImpl: EmbeddingFetch = fetch) {
    if (!options.baseUrl.trim()) throw new Error("Embedding baseUrl must not be empty");
    if (!options.model.trim()) throw new Error("Embedding model must not be empty");
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    if (texts.length === 0) return [];
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Embedding request timed out")), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
      if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`;
      const response = await this.fetchImpl(endpoint(this.options.baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: this.options.model, input: texts }),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Embedding endpoint returned HTTP ${response.status}: ${body.slice(0, 300)}`);
      const decoded = JSON.parse(body) as { data?: Array<{ index?: number; embedding?: unknown }> };
      if (!Array.isArray(decoded.data) || decoded.data.length !== texts.length) throw new Error("Embedding endpoint returned an unexpected number of vectors");
      const ordered = [...decoded.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      return ordered.map((item, index) => {
        if (!Array.isArray(item.embedding) || item.embedding.length === 0 || item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
          throw new Error(`Embedding endpoint returned an invalid vector at index ${index}`);
        }
        return item.embedding as number[];
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
