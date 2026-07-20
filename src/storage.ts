import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { PostsStore, StoredPost } from "./types.js";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_POSTS_PATH = path.join(ROOT_DIR, "data", "posts.json");

export function getDefaultPostsPath(): string {
  return DEFAULT_POSTS_PATH;
}

export async function loadPosts(
  filePath: string = DEFAULT_POSTS_PATH,
): Promise<PostsStore> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as PostsStore;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

export async function savePosts(
  posts: PostsStore,
  filePath: string = DEFAULT_POSTS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(posts, null, 2)}\n`;
  await writeFile(tmpPath, payload, "utf8");
  await rename(tmpPath, filePath);
}

export async function upsertPost(
  post: StoredPost,
  filePath: string = DEFAULT_POSTS_PATH,
): Promise<PostsStore> {
  const posts = await loadPosts(filePath);
  posts[post.id] = post;
  await savePosts(posts, filePath);
  return posts;
}

export async function upsertPosts(
  updates: StoredPost[],
  filePath: string = DEFAULT_POSTS_PATH,
): Promise<PostsStore> {
  const posts = await loadPosts(filePath);
  for (const post of updates) {
    posts[post.id] = post;
  }
  await savePosts(posts, filePath);
  return posts;
}

export function isStoreEmpty(posts: PostsStore): boolean {
  return Object.keys(posts).length === 0;
}
