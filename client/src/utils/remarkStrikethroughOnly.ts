import { visit } from 'unist-util-visit';

/**
 * Remark plugin to customize GFM features
 * Keeps: strikethrough (delete nodes), tables
 * Removes: task lists, autolinks
 */
export function remarkStrikethroughOnly() {
  return (tree: any) => {
    visit(tree, (node) => {
      // Remove task list items (convert to regular list items)
      if (node.type === 'listItem' && node.checked !== null && node.checked !== undefined) {
        node.checked = null;
      }
    });
  };
}
