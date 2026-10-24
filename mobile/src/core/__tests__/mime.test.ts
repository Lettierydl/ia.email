// Parsing MIME (porte de app/gmail_client.py) com mensagens sintéticas.
// Casos de imagem inline portados de tests/test_inline_images.py.
import { b64url, imgPart, message, thread } from '../__testutils__/fixtures';
import {
  b64Text, b64urlToB64, getAddresses, htmlToText, isImageFile, mapInlinePlaceholders, messageBodyText, threadAttachments, threadText,
  type MimeFile,
} from '../mime';

const file = (attachment_id: string, filename: string, mime_type: string, content_id = '', inline = false): MimeFile => ({
  message_id: 'm1', attachment_id, filename, mime_type, size: 1, content_id, inline, is_image: false, in_body: false,
});

describe('base64url e UTF-8', () => {
  it('decodifica texto com acento e emoji', () => {
    const s = 'Olá, ação até 10/10 — ok ✅ 🙂';
    expect(b64Text(b64url(s))).toBe(s);
  });
  it('byte inválido vira U+FFFD (errors="replace")', () => {
    expect(b64Text(b64url(Buffer.from([0x61, 0xff, 0x62])))).toBe('a�b');
    expect(b64Text(b64url(Buffer.from([0xc3])))).toBe('�');
  });
  it('base64url → base64 com padding', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x01]);
    expect(b64urlToB64(b64url(bytes))).toBe(bytes.toString('base64'));
  });
});

describe('texto da mensagem', () => {
  it('prefere text/plain', () => {
    const m = message('m1', { text: 'Texto puro', html: '<p>HTML</p>' });
    expect(messageBodyText(m.payload).text).toBe('Texto puro');
  });
  it('sem text/plain, converte o HTML (sem script/style, entidades, linhas em branco colapsadas)', () => {
    const html = '<html><style>p{color:red}</style><body><p>Olá&nbsp;&amp; bem-vindo</p><script>alert(1)</script><br><br><br><div>Linha&#33;</div></body></html>';
    expect(htmlToText(html)).toBe('Olá & bem-vindo\n\nLinha!');
    const m = message('m1', { html });
    expect(messageBodyText(m.payload).text).toBe('Olá & bem-vindo\n\nLinha!');
  });
  it('threadText no formato do get_thread_text, com corte em 8000', () => {
    const big = 'x'.repeat(8100);
    const t = thread('t1', [
      message('m1', { text: 'Primeira', from: 'Ana <ana@x.com>', date: 'Wed, 21 Oct 2026 09:00:00 -0300' }),
      message('m2', { text: big, from: 'Leo <leo@confrapag.com.br>', date: 'Thu, 22 Oct 2026 10:00:00 -0300' }),
    ]);
    const out = threadText(t);
    const blocks = out.split('\n\n----\n\n');
    expect(blocks[0]).toBe('De: Ana <ana@x.com>\nData: Wed, 21 Oct 2026 09:00:00 -0300\n\nPrimeira');
    expect(blocks[1].endsWith('x'.repeat(10) + '\n[cortado]')).toBe(true);
    expect(blocks[1].length).toBe('De: Leo <leo@confrapag.com.br>\nData: Thu, 22 Oct 2026 10:00:00 -0300\n\n'.length + 8000 + '\n[cortado]'.length);
  });
});

describe('imagens inline (test_inline_images.py)', () => {
  it('casa o placeholder pelo cid da <img> mesmo com alt diferente do arquivo', () => {
    const t = thread('t1', [
      message('m1', {
        text: 'Segue o print:\n[image: image.png]\nAbs',
        html: '<p>Segue o print:</p><img src="cid:ii_abc123" alt="image.png"><p>Abs</p>',
        parts: [imgPart('A1', 'outro.pdf', { disposition: 'attachment', mime: 'application/pdf' }), imgPart('A2', 'image.png', { cid: 'ii_abc123' })],
      }),
    ]);
    const out = threadAttachments(t);
    expect(out.message_ids).toEqual(['m1']);
    const ph = out.inline.m1;
    expect(ph).toHaveLength(1);
    expect(ph[0].token).toBe('[image: image.png]');
    expect(ph[0].attachment_id).toBe('A2');
    expect(ph[0].rule).toBe('cid');
    const byId = Object.fromEntries(out.files.map((f) => [f.attachment_id, f]));
    expect(byId.A2.content_id).toBe('ii_abc123');
    expect(byId.A2).toMatchObject({ inline: true, in_body: true, is_image: true });
    expect(byId.A1).toMatchObject({ in_body: false, is_image: false });
  });

  it('mesmo nome em várias imagens segue a ordem do HTML', () => {
    const html = '<img src="cid:c2" alt="image.png"> texto <img src="cid:c1" alt="image.png"> <img src="cid:c3" alt="image.png">';
    const t = thread('t1', [
      message('m1', {
        text: 'a [image: image.png] b [image: image.png] c [image: image.png]',
        html,
        parts: [imgPart('A1', 'image.png', { cid: 'c1' }), imgPart('A2', 'image.png', { cid: 'c2' }), imgPart('A3', 'image.png', { cid: 'c3' })],
      }),
    ]);
    expect(threadAttachments(t).inline.m1.map((p) => p.attachment_id)).toEqual(['A2', 'A1', 'A3']);
  });

  it('sem cid no HTML: nome do arquivo, depois ordem', () => {
    const files = [
      file('A1', 'foto.jpg', 'image/jpeg'),
      file('A2', 'grafico.png', 'image/png', '', true),
      file('A3', 'relatorio.pdf', 'application/pdf'),
    ];
    const ph = mapInlinePlaceholders('[imagem: foto.jpg] e [image: sem-nome.png] e [image: outro.png]', files, []);
    expect(ph.map((p) => [p.attachment_id, p.rule])).toEqual([['A1', 'filename'], ['A2', 'ordem'], [null, null]]);
  });

  it('[cid:x] direto e placeholder sem par fica texto', () => {
    const t = thread('t1', [
      message('m1', { text: 'veja [cid:logo@x] e [image: sumiu.png]', html: '<p>sem img</p>', parts: [imgPart('A1', 'logo.png', { cid: 'logo@x' })] }),
    ]);
    const ph = threadAttachments(t).inline.m1;
    expect(ph[0]).toMatchObject({ attachment_id: 'A1', rule: 'cid' });
    expect(ph[1].attachment_id).toBeNull();
  });

  it('mensagem sem imagens: placeholder sem anexo e lista vazia', () => {
    const out = threadAttachments(thread('t1', [message('m1', { text: '[image: image.png] sem anexo', html: '<p>x</p>' })]));
    expect(out.inline.m1[0].attachment_id).toBeNull();
    expect(out.files).toEqual([]);
  });

  it('SVG e PDF não são candidatos a inline', () => {
    const files = [file('S', 'x.svg', 'image/svg+xml', 's', true), file('P', 'x.pdf', 'application/pdf', 'p', true)];
    expect(mapInlinePlaceholders('[image: x.svg] [cid:p]', files, [{ cid: 's', alt: 'x.svg' }]).map((p) => p.attachment_id)).toEqual([null, null]);
    expect(isImageFile({ mime_type: 'application/octet-stream', filename: 'FOTO.JPEG' })).toBe(true);
  });

  it('anexos de mensagens diferentes ficam com o message_id certo', () => {
    const t = thread('t1', [
      message('m1', { text: 'sem nada' }),
      message('m2', { text: '[image: a.png]', parts: [imgPart('B1', 'a.png'), imgPart('B2', 'planilha.xlsx', { disposition: 'attachment', mime: 'application/vnd.ms-excel' })] }),
    ]);
    const out = threadAttachments(t);
    expect(out.message_ids).toEqual(['m1', 'm2']);
    expect(out.files.map((f) => [f.message_id, f.attachment_id, f.in_body])).toEqual([['m2', 'B1', true], ['m2', 'B2', false]]);
    expect(out.inline.m1).toBeUndefined();
  });
});

describe('endereços', () => {
  it('lista com nomes, aspas e vírgula dentro de aspas', () => {
    expect(getAddresses('"Souza, Ana" <ana@x.com>, bia@x.com, Leo <LEO@confrapag.com.br>')).toEqual([
      { name: 'Souza, Ana', email: 'ana@x.com' },
      { name: '', email: 'bia@x.com' },
      { name: 'Leo', email: 'LEO@confrapag.com.br' },
    ]);
    expect(getAddresses('')).toEqual([]);
  });
});
