import { useState, useMemo } from 'react';
import { marked } from 'marked';
import { RELEASE_CARDS, WHATS_NEW_VERSION } from '../components/WhatsNewModal';

// Raw markdown imports (bundled at build time via Vite ?raw)
import architectureMd from '@docs/architecture.md?raw';
import securityMd from '@docs/security.md?raw';
import apiReferenceMd from '@docs/api-reference.md?raw';

/* ── Sidebar sections ──────────────────────────────────────────────── */

interface DocSection {
  id: string;
  label: string;
  icon: JSX.Element;
  content: string | null; // null = custom renderer (What's New)
}

const ICON_SIZE = 16;

const SECTIONS: DocSection[] = [
  {
    id: 'whats-new',
    label: "What's New",
    icon: (
      <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    content: null,
  },
  {
    id: 'architecture',
    label: 'Architecture',
    icon: (
      <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" />
      </svg>
    ),
    content: architectureMd,
  },

  {
    id: 'security',
    label: 'Security',
    icon: (
      <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    content: securityMd,
  },
  {
    id: 'api-reference',
    label: 'API Reference',
    icon: (
      <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
      </svg>
    ),
    content: apiReferenceMd,
  },
];

/* ── Markdown renderer config ──────────────────────────────────────── */

marked.setOptions({ gfm: true, breaks: false });

/* ── Component ─────────────────────────────────────────────────────── */

export default function Documentation() {
  const [activeId, setActiveId] = useState(SECTIONS[0].id);
  const active = SECTIONS.find(s => s.id === activeId)!;

  // Memoise parsed HTML per section to avoid re-parsing on every render
  const htmlCache = useMemo(() => {
    const cache: Record<string, string> = {};
    for (const s of SECTIONS) {
      if (s.content) {
        cache[s.id] = marked.parse(s.content) as string;
      }
    }
    return cache;
  }, []);

  return (
    <div className="flex gap-6 min-h-[calc(100vh-4rem)]">
      {/* ── Left nav ── */}
      <nav
        className="shrink-0 w-52 sticky top-8 self-start flex flex-col gap-0.5"
      >
        <h2 className="text-xs uppercase tracking-widest text-txt-tertiary font-semibold mb-3 px-2.5">
          Documentation
        </h2>
        {SECTIONS.map(s => (
          <button
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={`flex items-center gap-2.5 rounded-md text-[0.8125rem] font-medium transition-all duration-150 py-2 px-2.5 text-left cursor-pointer
              ${activeId === s.id
                ? 'text-txt-primary bg-accent-dim font-semibold'
                : 'text-txt-secondary hover:text-txt-primary hover:bg-surface-secondary'
              }`}
          >
            {s.icon}
            {s.label}
          </button>
        ))}
      </nav>

      {/* ── Content area ── */}
      <div className="flex-1 min-w-0">
        {active.content !== null ? (
          <article
            className="prose-docs"
            dangerouslySetInnerHTML={{ __html: htmlCache[active.id] }}
          />
        ) : (
          <WhatsNewContent />
        )}
      </div>
    </div>
  );
}

/* ── What's New tab (reuses RELEASE_CARDS) ─────────────────────────── */

function WhatsNewContent() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-txt-primary mb-1">What's New</h1>
        <p className="text-sm text-txt-tertiary">
          Release highlights for Strata Client. Current version: <span className="font-semibold text-accent">{WHATS_NEW_VERSION}</span>
        </p>
      </div>

      <div className="space-y-6">
        {RELEASE_CARDS.map((card, idx) => (
          <div
            key={card.version}
            className="rounded-xl overflow-hidden"
            style={{
              background: 'var(--color-surface-secondary)',
              border: '1px solid var(--color-border)',
            }}
          >
            {/* Card header */}
            <div className="px-5 py-4 flex items-center gap-3" style={{ borderBottom: '1px solid var(--color-border)' }}>
              <div
                className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0"
                style={{
                  background: idx === 0 ? 'var(--color-accent)' : 'var(--color-surface-tertiary)',
                  color: idx === 0 ? 'white' : 'var(--color-txt-secondary)',
                }}
              >
                {idx === 0 ? '✦' : card.version.split('.').pop()}
              </div>
              <div>
                <h3 className="text-sm font-semibold text-txt-primary leading-tight">
                  v{card.version}
                  {idx === 0 && (
                    <span className="ml-2 text-[0.625rem] uppercase tracking-wider font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                      Latest
                    </span>
                  )}
                </h3>
                <p className="text-xs text-txt-tertiary">{card.subtitle}</p>
              </div>
            </div>

            {/* Card sections */}
            <div className="px-5 py-4 space-y-4">
              {card.sections.map((s, i) => (
                <div key={i}>
                  <h4 className="text-sm font-semibold text-txt-primary mb-1 flex items-center gap-2">
                    <span className="text-accent text-xs">●</span> {s.title}
                  </h4>
                  <p className="text-[0.8125rem] text-txt-secondary leading-relaxed">{s.description}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
