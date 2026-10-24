import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Output asisten yang dirender sebagai Markdown aman (heading, list, tebal,
 * kode, tabel). Dipisah dari `ChatView` agar aturan render terisolasi di satu
 * tempat.
 *
 * `react-markdown` membangun pohon React langsung — tidak ada
 * `dangerouslySetInnerHTML`, jadi HTML mentah dari model tidak pernah
 * dieksekusi dan tidak perlu sanitizer DOM terpisah.
 */

const REMARK_PLUGINS = [remarkGfm];

/**
 * Tautan dari output model dibuka di tab baru dan selalu memakai
 * `rel="noopener noreferrer"`. Properti `node` (metadata react-markdown) tidak
 * diteruskan ke DOM.
 */
const Anchor: Components["a"] = ({ node, ...rest }) => {
  void node;
  return <a {...rest} target="_blank" rel="noopener noreferrer" />;
};

const COMPONENTS: Components = { a: Anchor };

export function MarkdownText({
  text,
  className = "out md",
}: {
  text: string;
  /** Halaman publik memakai kelas sendiri; app tetap default `out md`. */
  className?: string;
}) {
  return (
    <div className={className} data-out>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
