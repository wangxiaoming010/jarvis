import { useState } from 'react';
import { Button, Popover } from '@heroui/react';
import { Camera, Check, ImagePlus, Smile, X } from 'lucide-react';
import { Tab, TabList, TabPanel, Tabs } from 'react-aria-components';
import type { BotAvatarSpec, Provider } from '@openbot/shared';
import { botAvatarSchema } from '@openbot/shared/schemas';
import { BotAvatar } from './Primitives';
import { avatarFromFile } from '../lib/avatar';

const emojis = ['🤖', '🧑‍💻', '👩‍🎨', '🦊', '🐼', '🐱', '🚀', '💡', '🌟', '🌈', '🍀', '🎯'];

export function AvatarEditor({
  value,
  onChange,
  name,
  provider,
  onBusyChange,
  disabled = false,
  presentation = 'inline',
}: {
  value: BotAvatarSpec | null;
  onChange: (value: BotAvatarSpec | null) => void;
  name: string;
  provider: Provider;
  onBusyChange: (busy: boolean) => void;
  disabled?: boolean;
  presentation?: 'inline' | 'popover';
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'default' | 'emoji' | 'image'>(value?.type ?? 'default');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const invalidEmoji = value?.type === 'emoji' && !botAvatarSchema.safeParse(value).success;
  async function upload(file?: File) {
    if (!file) return;
    setError('');
    setLoading(true);
    onBusyChange(true);
    try {
      onChange(await avatarFromFile(file));
      setMode('image');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      onBusyChange(false);
    }
  }
  const editor = (
    <fieldset className="avatar-editor" disabled={disabled || loading}>
      {presentation === 'inline' && (
        <>
          <legend>头像</legend>
          <div className="avatar-editor-head">
            <BotAvatar bot={{ name, provider, avatar: value }} size="large" />
          </div>
        </>
      )}
      <Tabs
        selectedKey={mode}
        onSelectionChange={(key) => {
          setMode(key as typeof mode);
          setError('');
        }}
      >
        <TabList className="avatar-mode-options" aria-label="头像类型">
          {(['default', 'emoji', 'image'] as const).map((option) => (
            <Tab key={option} id={option} isDisabled={disabled || loading}>
              {option === 'default' ? '默认' : option === 'emoji' ? 'Emoji' : '照片'}
            </Tab>
          ))}
        </TabList>
        <TabPanel id="default" className="avatar-default-editor">
          <BotAvatar bot={{ name, provider, avatar: null }} size="large" />
          <strong>简洁，也很有个性</strong>
          <p>根据名称自动搭配专属底色</p>
          <Button
            type="button"
            variant="tertiary"
            size="sm"
            isDisabled={disabled || loading}
            onPress={() => onChange(null)}
          >
            {!value && <Check size={14} />}
            {value ? '使用默认头像' : '已使用默认头像'}
          </Button>
        </TabPanel>
        <TabPanel id="emoji" className="avatar-emoji-editor">
          <div className="avatar-emoji-options" role="group" aria-label="常用 emoji">
            {emojis.map((emoji) => (
              <button
                type="button"
                key={emoji}
                aria-label={`使用 ${emoji} 作为头像`}
                aria-pressed={value?.type === 'emoji' && value.value === emoji}
                onClick={() => onChange({ type: 'emoji', value: emoji })}
              >
                {emoji}
                {value?.type === 'emoji' && value.value === emoji && (
                  <Check className="avatar-emoji-check" size={11} aria-hidden="true" />
                )}
              </button>
            ))}
          </div>
          <label className="avatar-emoji-input">
            <span>自定义 emoji</span>
            <input
              value={value?.type === 'emoji' ? value.value : ''}
              maxLength={32}
              aria-invalid={invalidEmoji || undefined}
              placeholder="输入或粘贴一个 emoji"
              onChange={(e) =>
                onChange(
                  e.target.value.trim() ? { type: 'emoji', value: e.target.value.trim() } : null,
                )
              }
            />
          </label>
          {invalidEmoji && <p role="alert">请选择或输入一个 emoji</p>}
        </TabPanel>
        <TabPanel id="image" className="avatar-photo-editor">
          <label className="avatar-upload-button">
            {value?.type === 'image' ? (
              <BotAvatar bot={{ name, provider, avatar: value }} size="large" />
            ) : (
              <span className="avatar-upload-icon">
                <ImagePlus size={24} />
              </span>
            )}
            <span>
              {loading ? '正在处理照片…' : value?.type === 'image' ? '更换照片' : '上传照片'}
            </span>
            <small>JPG、PNG 或 WebP · 最大 10 MB</small>
            <input
              type="file"
              aria-label="上传头像照片"
              accept="image/jpeg,image/png,image/webp"
              disabled={disabled || loading}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void upload(file);
              }}
            />
          </label>
          <small>照片会自动居中裁剪为正方形</small>
        </TabPanel>
      </Tabs>
      {value && presentation === 'inline' && (
        <Button
          type="button"
          variant="tertiary"
          size="sm"
          isDisabled={disabled || loading}
          onPress={() => {
            onChange(null);
            setMode('default');
            setError('');
          }}
        >
          恢复默认头像
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
  if (presentation === 'inline') return editor;
  return (
    <div className="avatar-picker">
      <Popover
        isOpen={open}
        onOpenChange={(next) => {
          if (loading) return;
          setOpen(next);
          if (next) {
            setMode(value?.type ?? 'default');
            setError('');
          }
        }}
      >
        <Button
          type="button"
          variant="ghost"
          className="avatar-picker-trigger"
          aria-label="选择头像"
          isDisabled={disabled || loading}
        >
          <BotAvatar bot={{ name, provider, avatar: value }} size="large" />
          <span className="avatar-picker-badge" aria-hidden="true">
            <Camera size={14} />
          </span>
        </Button>
        <Popover.Content
          className="avatar-picker-popover"
          placement="bottom"
          offset={12}
          containerPadding={16}
          isKeyboardDismissDisabled={loading}
        >
          <Popover.Dialog aria-label="选择头像" className="avatar-picker-dialog">
            <div className="avatar-picker-heading">
              <Popover.Heading>选择头像</Popover.Heading>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                isIconOnly
                aria-label="关闭头像选择"
                isDisabled={loading}
                onPress={() => setOpen(false)}
              >
                <X size={16} />
              </Button>
            </div>
            {editor}
            <div className="avatar-picker-footer">
              <span>
                <Smile size={13} /> 为新同事增添一点个性
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                isDisabled={loading || invalidEmoji}
                onPress={() => setOpen(false)}
              >
                完成
              </Button>
            </div>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <span className="avatar-picker-label">设置头像</span>
      <span className="avatar-picker-hint">点击头像，选择你喜欢的形象</span>
      {invalidEmoji && (
        <p className="form-error" role="alert">
          请选择或输入一个 emoji
        </p>
      )}
    </div>
  );
}
