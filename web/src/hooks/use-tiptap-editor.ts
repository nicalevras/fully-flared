import type { Editor } from '@tiptap/react';
import { useCurrentEditor, useEditorState } from '@tiptap/react';

export function useTiptapEditor(providedEditor?: Editor | null): {
  editor: Editor | null;
  editorState?: Editor['state'] | undefined;
  canCommand?: Editor['can'] | undefined;
} {
  const { editor: coreEditor } = useCurrentEditor();

  const editorState = useEditorState({
    editor: providedEditor ?? coreEditor,
    selector(context) {
      if (!context.editor) {
        return { editor: null, editorState: undefined, canCommand: undefined };
      }

      return {
        editor: context.editor,
        editorState: context.editor.state,
        canCommand: context.editor.can,
      };
    },
  });

  return editorState ?? { editor: null };
}
