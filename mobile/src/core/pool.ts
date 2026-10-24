// Executa fn em cada item com no máximo `concurrency` ao mesmo tempo.
// Erro de um item não para os outros: volta em `errors` (na ordem dos itens).
export async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<{ done: number; errors: { item: T; error: unknown }[] }> {
  let next = 0;
  let done = 0;
  const errors: { item: T; error: unknown; index: number }[] = [];
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      try {
        await fn(items[index], index);
      } catch (error) {
        errors.push({ item: items[index], error, index });
      }
      done += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  errors.sort((a, b) => a.index - b.index);
  return { done, errors: errors.map(({ item, error }) => ({ item, error })) };
}
