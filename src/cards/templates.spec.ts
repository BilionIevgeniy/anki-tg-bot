import { parseImport } from '../import/contract';
import { encode, decode } from '../bot/callback-data';
import { escapeHtml, renderBack, renderFront, richText, templatesFor } from './templates';

const geraet = {
  type: 'vocab_de',
  fields: {
    lemma: 'Gerät',
    article: 'das',
    plural: 'die Geräte',
    pos: 'noun',
    translation: 'прибор, устройство',
    example: 'Das Gerät ist <neu>.',
  },
};

describe('templates', () => {
  it('nouns with an article get three cards, other words two', () => {
    expect(templatesFor(geraet)).toEqual(['de_ru', 'ru_de', 'article']);
    expect(templatesFor({ type: 'vocab_de', fields: { lemma: 'schnell', pos: 'adj' } })).toEqual([
      'de_ru',
      'ru_de',
    ]);
    expect(templatesFor({ type: 'basic', fields: {}, reverse: true })).toEqual(['fwd', 'rev']);
  });

  it('renders and escapes HTML', () => {
    expect(renderFront(geraet, 'de_ru')).toBe('<b>das Gerät</b>');
    expect(renderFront(geraet, 'article')).toContain('___ Gerät');
    expect(renderFront(geraet, 'article')).not.toContain('das Gerät');
    const back = renderBack(geraet, 'de_ru');
    expect(back).toContain('Pl.: die Geräte');
    expect(back).toContain('&lt;neu&gt;');
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('supports light markup in basic cards', () => {
    expect(richText('use `useMemo` **now**')).toBe('use <code>useMemo</code> <b>now</b>');
    expect(richText('x\n```ts\nconst a = 1 < 2;\n```')).toBe('x\n<pre>const a = 1 &lt; 2;</pre>');
  });
});

describe('import contract', () => {
  it('accepts a valid file and applies defaults', () => {
    const r = parseImport(
      JSON.stringify({
        schemaVersion: 1,
        deck: { key: 'de-b2', name: 'Deutsch B2' },
        notes: [{ externalId: 'de:geraet', type: 'vocab_de', fields: geraet.fields }],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.data?.notes[0]?.tags).toEqual([]);
  });

  it('reports readable errors and duplicate ids', () => {
    const r = parseImport(
      JSON.stringify({
        schemaVersion: 1,
        deck: { key: 'DE B2', name: 'x' },
        notes: [
          { externalId: 'a', type: 'basic', fields: { front: 'q', back: 'a' } },
          { externalId: 'a', type: 'basic', fields: { front: 'q', back: '' } },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.startsWith('deck.key'))).toBe(true);
    expect(r.errors.some((e) => e.includes('дубль'))).toBe(true);
    expect(parseImport('{oops').errors[0]).toMatch(/^Это не JSON/);
  });
});

describe('callback data', () => {
  it('round-trips and stays under 64 bytes', () => {
    const cb = { a: 'rate', cardId: 123456789, rating: 3, version: 99999, scope: 123456 } as const;
    const s = encode(cb);
    expect(Buffer.byteLength(s)).toBeLessThanOrEqual(64);
    expect(decode(s)).toEqual(cb);
    expect(decode('r:1:9:0:0')).toBeNull();
    expect(decode('garbage')).toBeNull();
  });
});
