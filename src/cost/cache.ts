import { createHash } from "node:crypto";
import type { ChatMessage } from "../llm/chatModel";

/**
 * Response cache keyed by (namespace, content version, messages-hash). Bumping
 * the version invalidates the whole cache (e.g. when the corpus or prompts
 * change); the namespace (the caller passes the org id) makes a cached response
 * un-shareable across tenants — a structural isolation guard on top of the fact
 * that answer messages already embed tenant-scoped context. A cache hit avoids
 * the model call entirely — the core cost lever behind the projection's
 * `cacheHitRate`.
 */
export class ResponseCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly version = "v1") {}

  private key(messages: ChatMessage[], namespace: string): string {
    const digest = createHash("md5").update(JSON.stringify(messages)).digest("hex");
    return `${this.version}:${namespace}:${digest}`;
  }

  get(messages: ChatMessage[], namespace = "_"): string | undefined {
    return this.map.get(this.key(messages, namespace));
  }

  set(messages: ChatMessage[], text: string, namespace = "_"): void {
    this.map.set(this.key(messages, namespace), text);
  }

  get size(): number {
    return this.map.size;
  }
}
