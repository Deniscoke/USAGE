"use client";

import { Fragment, type ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/chat/markdown";

/**
 * A reply, rendered.
 *
 * Every node here is a React element built from the parsed tree. No HTML
 * string is ever produced, so nothing a model writes can become markup: the
 * worst a hostile reply can do is look like text, which is what it is.
 */

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map((block, index) => renderBlock(block, index))}</>;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6");
      return (
        <Tag key={key} className={`md-h md-h${block.level}`}>
          {renderInline(block.children)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderInline(block.children)}
        </p>
      );
    case "list":
      return block.ordered ? (
        <ol key={key} className="md-ol" start={block.start}>
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul key={key} className="md-ul">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
    case "code":
      return <CodeBlock key={key} language={block.language} value={block.value} />;
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderInline(block.children)}
        </blockquote>
      );
    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{renderInline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="md-rule" />;
  }
}

function renderInline(nodes: readonly Inline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text":
        return <Fragment key={index}>{node.value}</Fragment>;
      case "strong":
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "code":
        return (
          <code key={index} className="md-code">
            {node.value}
          </code>
        );
      case "link":
        return (
          // A link in a reply leads somewhere the model chose, so it opens in
          // its own tab and cannot reach back into this one.
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow" className="md-link">
            {renderInline(node.children)}
          </a>
        );
    }
  });
}

function CodeBlock({ language, value }: { language: string | null; value: string }) {
  return (
    <div className="md-pre">
      <div className="md-pre__head">
        <span>{language ?? "text"}</span>
        <button type="button" className="chat-link" onClick={() => void navigator.clipboard?.writeText(value)}>
          Copy
        </button>
      </div>
      <pre>
        <code>{value}</code>
      </pre>
    </div>
  );
}
