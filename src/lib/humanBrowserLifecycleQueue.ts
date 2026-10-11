/**
 * Serializes native human-browser lifecycle calls across all overlay owners.
 * The internal tail handles rejections so one failed WebKit operation cannot
 * permanently stall later cleanup requests. The returned promise still rejects.
 */
export class HumanBrowserLifecycleQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function isHumanBrowserLifecycleBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("lifecycle is busy");
}

/** Hide/destroy must not be dropped because add_child still holds the permit. */
export async function retryHumanBrowserLifecycle<T>(
  operation: () => Promise<T>,
  attempts = 5,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isHumanBrowserLifecycleBusy(error) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 16 * (attempt + 1));
      });
    }
  }
  throw lastError;
}
