import { useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { richTextCls } from '../lib/rich-text';
import { uploadMedia } from '../lib/upload';
import { runEditorSave } from '../lib/blog-save';

// Blog editor (DECISIONS P3: TipTap). Content is stored as HTML + JSON so the
// editor stays replaceable without a content migration.
export function BlogEditor({
  initialHtml,
  onSave,
}: {
  initialHtml?: string;
  onSave: (html: string, json: string) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const editor = useEditor({
    extensions: [StarterKit, Image],
    content: initialHtml ?? '',
    // TipTap React docs: defer first render under SSR and do not re-render
    // the component on every transaction.
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: `${richTextCls} min-h-56 px-5 py-4 focus:outline-none`,
        'aria-label': 'Post content',
      },
    },
  });

  if (!editor) {
    return (
      <div
        className="min-h-56 rounded-xl border border-zinc-300 bg-white px-5 py-4 text-sm text-zinc-500"
        role="status"
      >
        Loading editor…
      </div>
    );
  }

  async function addImage() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setUploadError('');
      try {
        const data = await uploadMedia(file, file.name);
        if (data.url) editor?.chain().focus().setImage({ src: data.url, alt: file.name }).run();
        else setUploadError('Image upload failed');
      } catch (err) {
        setUploadError(
          err instanceof Error ? err.message : 'Image upload could not reach the server.'
        );
      }
    };
    input.click();
  }

  const tool =
    'rounded-md px-2.5 py-1.5 text-[13px] font-medium text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950';

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5">
        <button
          type="button"
          className={`${tool} font-bold`}
          aria-label="Bold"
          aria-pressed={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          B
        </button>
        <button
          type="button"
          className={`${tool} italic`}
          aria-label="Italic"
          aria-pressed={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          I
        </button>
        <button
          type="button"
          className={tool}
          aria-label="Heading level 2"
          aria-pressed={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          Heading
        </button>
        <button
          type="button"
          className={tool}
          aria-label="Bullet list"
          aria-pressed={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          List
        </button>
        <button type="button" className={tool} aria-label="Insert image" onClick={addImage}>
          Insert image
        </button>
        {uploadError ? (
          <span className="px-2 text-[13px] text-red-600" role="alert">
            {uploadError}
          </span>
        ) : null}
        <button
          type="button"
          disabled={saving}
          className="ml-auto inline-flex h-8 items-center rounded-full bg-zinc-950 px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-zinc-800 disabled:opacity-40"
          onClick={() =>
            void runEditorSave({
              setSaving,
              onSave: () => onSave(editor.getHTML(), JSON.stringify(editor.getJSON())),
            })
          }
        >
          {saving ? 'Saving…' : 'Save post'}
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
