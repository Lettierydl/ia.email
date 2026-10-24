// Nenhum teste fala com a rede: fetch real é trocado por um que falha alto.
// Testes usam fetch falso injetado (fakeFetch / Gmail falso / IA falsa).
globalThis.fetch = async (url) => {
  throw new Error(`Teste tentou usar fetch real (${String(url).split('?')[0]}): injete um fetch falso.`);
};
