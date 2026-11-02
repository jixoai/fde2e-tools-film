/*
 * IconPlaceholder —— shadcn 官方 registry（base-nova）组件的图标适配位。
 * 官方 create 模板按图标库分发（lucide/tabler/hugeicons/phosphor/remixicon）；
 * 本仓 icon 库＝lucide-react（FDE2E 视觉语言，见 .agents/skills/shadcn/SKILL.md icons 规则），
 * 故映射取 lucide 位。适配点机械替换，其余官方源逐字保留。
 */
import {
  CheckIcon,
  ChevronRightIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  CheckIcon,
  ChevronRightIcon,
  XIcon,
};

export function IconPlaceholder({
  lucide,
  ...props
}: {
  lucide: string;
} & Record<string, unknown>) {
  const Icon = ICONS[lucide];
  return Icon ? <Icon {...props} /> : null;
}
