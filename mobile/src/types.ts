// Contrato de /api/copilot (espelha app/copilot.py: _present, detail, act, digest).

export type Papel = 'so_copia' | 'mencionado_opiniao' | 'demanda' | 'fyi' | 'pode_ignorar';
export type Urgencia = 'alta' | 'media' | 'baixa' | 'neutra';
export type Status = 'aberto' | 'assumido' | 'delegado' | 'cobrado' | 'aguardando' | 'resolvido';
// "resolvido" não é mais coluna do quadro (vira histórico), mas continua valendo em `item.tab`.
export type TabKey = 'precisa_de_voce' | 'bola_com_outros' | 'so_conhecimento' | 'resolvido';
// "analisando" não é aba de classificação: é a fila do que a IA ainda não leu.
export type ItemTab = TabKey | 'analisando';
export type Acao = 'direcionar' | 'estudar_depois_responder' | 'pedir_contexto' | 'responder' | 'aguardar';
export type ModoDelegar = 'cc_originais' | 'novo_silencioso';

export interface Pessoa {
  nome: string;
  email: string;
}

export interface Bola extends Pessoa {
  com: 'leo' | 'outros' | 'ninguem';
}

export interface Evidencia {
  tipo: 'mensagem' | 'learning_base' | 'decisao' | string;
  titulo: string;
  trecho: string;
  porque?: string;
}

export interface Opcao {
  acao: Acao;
  texto: string;
  para: string;
  confianca: number;
  evidencias: Evidencia[];
}

export interface Tarefa {
  texto: string;
  feita: boolean;
}

export interface Item {
  thread_id: string;
  subject: string;
  from_name: string;
  from_email: string;
  internal_date: number;
  is_unread: boolean;
  /** já tem leitura ou ação do copiloto gravada */
  no_copiloto?: boolean;
  analisado: boolean;
  lido_por_regra?: boolean;
  desatualizado: boolean;
  tab: ItemTab;
  /** a IA ainda não leu: fica na fila "Analisando", fora das abas do quadro */
  pendente?: boolean;
  /** a leitura da IA deu erro: continua na fila até pedir de novo */
  falhou?: boolean;
  papel: Papel;
  o_que_aconteceu: string;
  opcoes: Opcao[];
  urgencia: Urgencia;
  bola: Bola;
  depende_de_outros: boolean;
  sem_resposta_desde: number | null;
  prazo: string;
  quem_pediu: Pessoa;
  tarefas: Tarefa[];
  needs_context: boolean;
  o_que_falta: string;
  pergunta: string;
  status: Status;
  source: 'llm' | 'heuristica' | 'regra';
  delegado: { modo?: ModoDelegar; para?: string; nome?: string; assunto?: string };
  analyzed_at: string | null;
}

export interface ItemDetail extends Item {
  originarios: { name: string; email: string }[];
  historico: { acao: string; at: string; para?: string; modo?: string }[];
  thread_text?: string;
  mensagens?: { de: string; data: string; texto: string }[];
  resumo_contexto?: ResumoContexto;
  /** rascunho de resposta salvo na thread (o mesmo do /mail) */
  draft?: string;
  /** quem pediu / respondido / sem resposta, das mensagens reais (copilot.conversa) */
  conversa?: Conversa | null;
}

export interface ConversaPessoa {
  nome: string;
  email: string;
  voce: boolean;
  em: number | null;
  quando: string;
}

export interface Conversa {
  status: 'aguardando' | 'respondido' | 'sem_pedido';
  solicitante: ConversaPessoa | null;
  respondido: ConversaPessoa | null;
  ultimo: ConversaPessoa;
  aguardando_desde: number | null;
  rotulo_resposta: string;
  rotulo_ultimo: string;
  total: number;
}

export interface Endereco {
  name: string;
  email: string;
}

/** Para/Cc da última mensagem (/api/threads/{id}/recipients). reply_to/reply_cc =
 * o padrão do envio ("responder a todos", sem você); participants = todo mundo da thread. */
export interface Recipients {
  to: Endereco[];
  cc: Endereco[];
  reply_to?: Endereco[];
  reply_cc?: Endereco[];
  participants?: Endereco[];
  /** só no modo local: mensagens da thread para escolher qual responder */
  messages?: ComposeMessage[];
  /** mensagem que o Para/Cc acima responde (padrão: a última de outra pessoa) */
  target_id?: string;
}

/** Uma mensagem da thread no seletor "Responder a" do composer. */
export interface ComposeMessage {
  id: string;
  idx: number;
  de: string;
  email: string;
  data: string;
  snippet: string;
  voce: boolean;
}

/** Envio confirmado no composer (ConfirmModal). */
export interface SendInput {
  text: string;
  cc: string;
  to: string[];
  /** id do Gmail da mensagem respondida (vazio = padrão) */
  replyToMessageId?: string;
}

/** Item da fila de envio do aparelho (modo local). */
export interface OutboxView {
  id: string;
  kind: 'reply' | 'new';
  thread_id: string;
  to: string;
  subject: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  last_error: string;
  attempts: number;
  /** ms: até quando dá para desfazer sem ter saído; 0 = janela passou */
  undo_until: number;
}

/** Resposta do POST /api/threads/{id}/draft. */
export interface DraftResult {
  draft: string;
  chat?: { role: string; text: string; kind?: string }[];
  /** guarda do backend: a IA pode ter copiado o pedido ou colado pontos sem responder */
  alerta_copia?: { mensagem?: string; trechos?: string[] };
  unchanged?: boolean;
  /** "usar meu texto": aviso quando a correção de português não foi aplicada */
  aviso?: string;
}

/** Anexo recebido na thread (GET /api/threads/{id}/gmail-attachments). */
export interface GmailFile {
  message_id: string;
  attachment_id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string;
  inline: boolean;
  is_image: boolean;
  /** já aparece no corpo como imagem inline */
  in_body: boolean;
}

/** Cada "[image: x]" do texto de uma mensagem -> anexo (ou null sem par). */
export interface InlinePlaceholder {
  token: string;
  name: string;
  attachment_id: string | null;
  filename: string | null;
}

export interface GmailAttachments {
  files: GmailFile[];
  /** ids do Gmail na mesma ordem de `mensagens` do detalhe */
  message_ids: string[];
  inline: Record<string, InlinePlaceholder[]>;
}

/** "Verificar na caixa" (GET = só cache; POST = gera). afirmacoes null = sem cache. */
export interface VerifyEvidence {
  assunto: string;
  de: string;
  data: string;
  snippet: string;
  mesma_thread: boolean;
  gmail_url: string;
  pasta?: string;
}
export interface VerifyClaim {
  texto: string;
  veredito: 'confirmado' | 'nao_encontrado' | 'inconclusivo' | string;
  explicacao?: string;
  evidencias?: VerifyEvidence[];
}
export interface VerifyResult {
  afirmacoes: VerifyClaim[] | null;
  aviso?: string;
  gerado_em: string;
  cached: boolean;
  desatualizado: boolean;
}

/** Resumo detalhado da thread / resumo de uma mensagem. */
export type ResumoLista = (string | { nome?: string; pedido?: string; data?: string; o_que?: string })[];
export interface ResumoDetalhado {
  resumo: Record<string, string | ResumoLista> | null;
  gerado_em: string;
  cached: boolean;
  desatualizado: boolean;
  aviso?: string;
}
export type ModoResumoMsg = 'direto' | 'abrangente';
export interface ResumoMensagem {
  idx: number;
  modo: ModoResumoMsg;
  resumo: Record<string, string | ResumoLista> | null;
  gerado_em: string;
  cached: boolean;
}

/** Histórico de ações (/api/historico). */
export interface HistEntry {
  id: number;
  at: string;
  thread_id: string;
  n: number;
  assunto: string;
  acao: string;
  rotulo: string;
  origem: string;
  desfazivel: boolean;
  motivo: string;
  desfeito: boolean;
  estado: 'nao_reversivel' | 'desfeito' | 'ativo';
}
export interface HistList {
  items: HistEntry[];
  proximo: number | null;
}

export interface SendResult {
  ok: boolean;
  to?: string;
  cc?: string;
  /** sem conexão com o Gmail: o servidor guardou na fila de envio (HTTP 202) */
  queued?: boolean;
  message?: string;
  outbox_id?: string;
  /** modo local: ms até quando o envio pode ser desfeito */
  undo_until?: number;
}

/** Estado da conexão do servidor com o Gmail (GET /api/sync/status). */
export interface SyncStatus {
  status: 'online' | 'offline' | 'auth_error';
  last_sync_at?: string | null;
  last_sync_label?: string;
  minutes_since_sync?: number | null;
  last_error?: string;
  gmail_primary_unread?: number | null;
  outbox?: { queued: number; sending: number; failed: number; pending: number };
  result?: { fetched?: number };
}

export interface AppStatus {
  account: string;
  can_send: boolean;
}

export interface TrechoPessoa extends Pessoa {
  data: string;
  trecho: string;
  voce?: boolean;
}

/** Contexto da conversa (sem IA): quem abriu pedindo o quê, sua resposta, último a escrever. */
export interface ResumoContexto {
  o_que_aconteceu: string;
  total_mensagens: number;
  abertura: TrechoPessoa | null;
  sua_resposta: TrechoPessoa | null;
  ultima: TrechoPessoa | null;
}

export interface Job {
  running: boolean;
  done: number;
  total: number;
  current: string;
  current_id?: string;
  pending?: string[];
  errors: number;
  finished_at: string | null;
  /** lote pausado por falta de conexão */
  paused?: string;
}

export interface CopilotList {
  saudacao: string;
  data: string;
  cards: { hoje: number; esperando_outros: number };
  tabs: { key: TabKey; title: string; count: number }[];
  /** histórico fora do quadro (Resolvidos, Marcados como lido); ausente em servidor antigo */
  historico?: { key: 'resolvido' | 'lidos'; title: string; count: number }[];
  /** fila à parte; ausente em servidor antigo. ativa = há chave de IA (sem IA não há fila) */
  fila?: { key: 'analisando'; title: string; count: number; falhas: number; ativa: boolean };
  items: Item[];
  show_all: boolean;
  total: number;
  job: Job;
  /** estado do sync com o Gmail; ausente em servidor antigo */
  sync?: SyncStatus;
  llm: boolean;
}

export interface ActionResult {
  ok: boolean;
  action: string;
  item: ItemDetail;
  draft?: string;
  open_url?: string;
  para?: string;
  acao?: Acao;
  /** modo local: e-mail novo preparado (delegar silencioso / cobrar) — só sai pelo composer */
  compose?: { to: string; subject: string; body: string };
}

export interface Digest {
  period: 'daily' | 'weekly';
  titulo: string;
  secoes: { titulo: string; itens: string[] }[];
  texto: string;
  agendamento: string;
  ativo: boolean;
}

/** "Aprender": regra/contexto que vale para a conversa/assunto, uma pessoa ou sempre. */
export type LearnedScope = 'thread' | 'person' | 'general';

export interface LearnedNote {
  id: number;
  scope: LearnedScope;
  text: string;
  thread_id: string;
  subject: string;
  person_email: string;
  created_at: string;
}

export interface Prefs {
  skin: 'clean' | 'caderno';
  digest_daily: string;
  digest_weekly_day: number;
  digest_weekly_time: string;
  digest_enabled: boolean;
  show_all: boolean;
  /** cards da coluna lateral do detalhe (Configurações → Copiloto) */
  show_tasks_card?: boolean;
  show_facts_card?: boolean;
}
