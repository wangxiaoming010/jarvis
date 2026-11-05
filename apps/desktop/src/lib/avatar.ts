import type { BotAvatarSpec } from '@openbot/shared';
import { botAvatarSchema } from '@openbot/shared/schemas';

export async function avatarFromFile(file: File): Promise<BotAvatarSpec> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type))
    throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error('无法读取这张图片，请选择其他图片');
    });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('暂时无法处理图片，请重试');
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    if (!edge) throw new Error('无法读取这张图片，请选择其他图片');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, 256, 256);
    context.drawImage(
      image,
      (image.naturalWidth - edge) / 2,
      (image.naturalHeight - edge) / 2,
      edge,
      edge,
      0,
      0,
      256,
      256,
    );
    return botAvatarSchema.parse({ type: 'image', value: canvas.toDataURL('image/jpeg', 0.85) });
  } finally {
    URL.revokeObjectURL(url);
  }
}
