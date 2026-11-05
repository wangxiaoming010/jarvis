import { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
export function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        if (source.length > 16000) throw new Error('流程图内容过长');
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          maxEdges: 100,
          maxTextSize: 16000,
        });
        const { svg } = await mermaid.render(
          'diagram-' + crypto.randomUUID().replaceAll('-', ''),
          source,
        );
        if (active && ref.current)
          ref.current.innerHTML = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'a'],
          });
      } catch (e) {
        if (active)
          setError(
            source.length > 16000 ? '图表内容过长，无法显示。' : '无法显示图表，请检查图表内容。',
          );
      }
    })();
    return () => {
      active = false;
    };
  }, [source]);
  return error ? (
    <p role="alert" className="callout">
      {error}
    </p>
  ) : (
    <div ref={ref} className="mermaid-view" />
  );
}
