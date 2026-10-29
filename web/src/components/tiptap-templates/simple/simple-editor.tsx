import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, EditorContext, useEditor, useEditorState } from '@tiptap/react';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { FindAndReplace } from '@tiptap/extension-find-and-replace';
import { Selection } from '@tiptap/extensions';
import { Button } from '@/components/tiptap-ui-primitive/button';
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/tiptap-ui-primitive/toolbar';
import { ImageUploadNode } from '@/components/tiptap-node/image-upload-node/image-upload-node-extension';
import { HorizontalRule } from '@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node-extension';
import { HeadingDropdownMenu } from '@/components/tiptap-ui/heading-dropdown-menu';
import { ImageUploadButton } from '@/components/tiptap-ui/image-upload-button';
import { ListDropdownMenu } from '@/components/tiptap-ui/list-dropdown-menu';
import { BlockquoteButton } from '@/components/tiptap-ui/blockquote-button';
import { CodeBlockButton } from '@/components/tiptap-ui/code-block-button';
import { LinkPopover } from '@/components/tiptap-ui/link-popover';
import { MarkButton } from '@/components/tiptap-ui/mark-button';
import { UndoRedoButton } from '@/components/tiptap-ui/undo-redo-button';
import {
  SearchAndReplace,
  SearchAndReplaceButton,
} from '@/components/tiptap-ui/search-and-replace';
import { handleImageUpload, MAX_FILE_SIZE } from '@/lib/tiptap-utils';
import { runEditorSave } from '@/lib/blog-save';
import '@/styles/_variables.scss';
import '@/styles/_keyframe-animations.scss';
import '@/components/tiptap-node/blockquote-node/blockquote-node.scss';
import '@/components/tiptap-node/code-block-node/code-block-node.scss';
import '@/components/tiptap-node/horizontal-rule-node/horizontal-rule-node.scss';
import '@/components/tiptap-node/list-node/list-node.scss';
import '@/components/tiptap-node/image-node/image-node.scss';
import '@/components/tiptap-node/heading-node/heading-node.scss';
import '@/components/tiptap-node/paragraph-node/paragraph-node.scss';
import './simple-editor.scss';

export function SimpleEditor({
  initialHtml,
  onSave,
  onChange,
  showSave,
  onUploadPendingChange,
}: {
  initialHtml?: string;
  onSave?: (html: string, json: string) => Promise<void>;
  onChange?: (html: string, json: string) => void;
  showSave?: boolean;
  onUploadPendingChange?: (pending: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const searchButton = useRef<HTMLButtonElement>(null);
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'simple-editor', 'aria-label': 'Rich text content' },
    },
    extensions: [
      StarterKit.configure({
        horizontalRule: false,
        link: { openOnClick: false, enableClickSelection: true },
      }),
      HorizontalRule,
      Image,
      Selection,
      FindAndReplace.configure({ searchDebounceMs: 500, injectCSS: false }),
      ImageUploadNode.configure({
        accept: 'image/jpeg,image/png,image/webp,image/gif',
        maxSize: MAX_FILE_SIZE,
        limit: 3,
        upload: handleImageUpload,
        onError: (error) => setUploadError(error.message),
        onSuccess: () => setUploadError(''),
      }),
    ],
    content: initialHtml ?? '',
    onUpdate: ({ editor: current }) =>
      onChange?.(current.getHTML(), JSON.stringify(current.getJSON())),
  });
  const pendingUpload = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      let pending = false;
      current?.state.doc.descendants((node) => {
        if (node.type.name === 'imageUpload') pending = true;
      });
      return pending;
    },
  });
  useEffect(() => {
    onUploadPendingChange?.(pendingUpload === true);
    return () => onUploadPendingChange?.(false);
  }, [pendingUpload, onUploadPendingChange]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    searchButton.current?.focus();
  }, []);

  if (!editor) {
    return (
      <div
        className="min-h-56 rounded-xl border border-zinc-200 bg-white px-5 py-4 text-sm text-zinc-500"
        role="status"
      >
        Loading editor…
      </div>
    );
  }

  return (
    <div className="simple-editor-wrapper">
      <EditorContext.Provider value={{ editor }}>
        <Toolbar aria-label="Text formatting">
          <ToolbarGroup>
            <UndoRedoButton action="undo" />
            <UndoRedoButton action="redo" />
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToolbarGroup>
            <HeadingDropdownMenu modal={false} levels={[2, 3]} />
            <ListDropdownMenu modal={false} types={['bulletList', 'orderedList']} />
            <BlockquoteButton />
            <CodeBlockButton />
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToolbarGroup>
            <MarkButton type="bold" />
            <MarkButton type="italic" />
            <MarkButton type="underline" />
            <MarkButton type="strike" />
            <MarkButton type="code" />
            <LinkPopover />
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToolbarGroup>
            <ImageUploadButton text="Image" />
            <SearchAndReplaceButton
              ref={searchButton}
              aria-expanded={searchOpen}
              data-active-state={searchOpen ? 'on' : 'off'}
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            />
          </ToolbarGroup>
        </Toolbar>
        <SearchAndReplace
          className="simple-editor-search-and-replace"
          open={searchOpen}
          onOpen={() => setSearchOpen(true)}
          onClose={closeSearch}
          scrollIntoViewOptions={{ block: 'nearest' }}
        />
        <EditorContent editor={editor} role="presentation" className="simple-editor-content" />
        {uploadError ? (
          <p className="px-5 pb-3 text-sm text-red-600" role="alert">
            {uploadError}
          </p>
        ) : null}
        {onChange && !showSave ? null : (
          <div className="simple-editor-footer">
            {pendingUpload ? (
              <span role="status">Finish or remove image uploads before saving.</span>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              disabled={saving || pendingUpload === true}
              onClick={() =>
                void runEditorSave({
                  setSaving,
                  onSave: async () => {
                    if (onSave) await onSave(editor.getHTML(), JSON.stringify(editor.getJSON()));
                  },
                })
              }
            >
              {saving ? 'Saving…' : 'Save post'}
            </Button>
          </div>
        )}
      </EditorContext.Provider>
    </div>
  );
}
