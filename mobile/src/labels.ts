// Rótulos em pt-BR (mesmos do static/copilot.js).
import type { Acao, Papel, Status, Urgencia } from './types';

export const PAPEL: Record<Papel, string> = {
  so_copia: 'Só cópia',
  mencionado_opiniao: 'Pedem sua opinião',
  demanda: 'Demanda sua',
  fyi: 'Para saber',
  pode_ignorar: 'Pode ignorar',
};

export const PAPEL_HINT: Record<Papel, string> = {
  so_copia: 'Você está em cópia; ninguém pediu nada a você.',
  mencionado_opiniao: 'Citaram você ou querem sua opinião.',
  demanda: 'Tem algo que depende de você fazer ou decidir.',
  fyi: 'Informativo: bom saber, sem ação.',
  pode_ignorar: 'Ruído: aviso automático ou divulgação.',
};

export const ACAO: Record<Acao, string> = {
  direcionar: 'Direcionar',
  estudar_depois_responder: 'Estudar e depois responder',
  pedir_contexto: 'Pedir contexto',
  responder: 'Responder',
  aguardar: 'Aguardar',
};

export const EVID: Record<string, string> = { mensagem: 'Na mensagem', learning_base: 'Learning Base', decisao: 'Decisão anterior' };

export const URG: Record<Urgencia, string> = { alta: 'urgência alta', media: 'urgência média', baixa: 'urgência baixa', neutra: '' };

export const STATUS: Partial<Record<Status, string>> = {
  assumido: 'você acompanha',
  delegado: 'delegado',
  cobrado: 'cobrado',
  aguardando: 'aguardando',
  resolvido: 'resolvido',
};

// Títulos das colunas do quadro (a API manda os mesmos em `tabs`; a chave
// `bola_com_outros` continua estável). "Resolvido" não é coluna: vira histórico.
export const TAB_TITLE: Record<'precisa_de_voce' | 'bola_com_outros' | 'so_conhecimento', string> = {
  precisa_de_voce: 'Precisa de você',
  bola_com_outros: 'Aguardando outras pessoas',
  so_conhecimento: 'Só conhecimento',
};

export const WEEK = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];

export function ago(ms: number | null | undefined): string {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'hoje';
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

export const ddmm = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
