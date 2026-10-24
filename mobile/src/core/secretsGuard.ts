// Texto que parece senha, token ou chave — porte 1:1 de app/secrets_guard.py.
// O copiloto não manda para a IA um e-mail que bate aqui (prefere errar
// bloqueando: perder um trecho é barato, vazar credencial num prompt não).
const PATTERNS = [
  // senha: xyz / token=abc / api key: ...
  /\b(senha|password|passwd|pwd|secret|segredo|token|api[ _-]?key|apikey|client[ _-]?secret)\b\s*[:=]\s*\S{4,}/i,
  // "usuário x / senha 123456": senha seguida de algo que tem dígito
  /\b(senha|password|passwd|pwd)\b\s+(?=\S*\d)\S{4,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})\b/,
  /\bbearer\s+[A-Za-z0-9._-]{20,}/i,
];

export function looksLikeSecret(text: string | null | undefined): boolean {
  if (!text) return false;
  return PATTERNS.some((p) => p.test(text));
}
