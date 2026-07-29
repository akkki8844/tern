
import Parser from "tree-sitter";
import { ImportBinding } from "./interfaces";

export function extractImportBindings(tree: Parser.Tree): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const cursor = tree.walk();
  const visit = () => {
    const node = cursor.currentNode;
    if (node.type === "import_statement" || node.type === "import_declaration") {
      const source = extractImportSource(node);
      if (source) collectBindings(node, source, bindings);
    }
    if (cursor.gotoFirstChild()) {
      do { visit(); } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  };
  visit();
  return bindings;
}

function extractImportSource(node: Parser.SyntaxNode): string | undefined {
  const sourceNode = node.childForFieldName("source");
  if (!sourceNode) return undefined;
  return sourceNode.text.replace(/^['"]|['"]$/g, "");
}

function collectBindings(node: Parser.SyntaxNode, source: string, bindings: Map<string, ImportBinding>): void {
  const clause = findImportClause(node);
  if (!clause) return;
  for (const child of clause.children) {
    if (child.type === "identifier") {
      bindings.set(child.text, { name: child.text, source, isDefault: true, isNamespace: false, isRenamed: false, localName: child.text });
    } else if (child.type === "namespace_import") {
      const id = child.childForFieldName("name")?.text;
      if (id) bindings.set(id, { name: id, source, isDefault: false, isNamespace: true, isRenamed: false, localName: id });
    } else if (child.type === "named_imports") {
      collectNamedImports(child, source, bindings);
    }
  }
}

function findImportClause(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  for (const child of node.children) {
    if (child.type === "import_clause") return child;
  }
  return undefined;
}

function collectNamedImports(node: Parser.SyntaxNode, source: string, bindings: Map<string, ImportBinding>): void {
  for (const spec of node.children) {
    if (spec.type !== "import_specifier") continue;
    const nameNode = spec.childForFieldName("name");
    const aliasNode = spec.childForFieldName("alias");
    const name = nameNode?.text;
    const alias = aliasNode?.text || name;
    if (name && alias) {
      bindings.set(alias, {
        name, source, isDefault: false, isNamespace: false,
        isRenamed: alias !== name, localName: alias,
        aliasMap: alias !== name ? new Map([[name, alias]]) : undefined
      });
    }
  }
}
