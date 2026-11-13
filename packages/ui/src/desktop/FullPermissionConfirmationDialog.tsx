import { TriangleAlertIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './components/ui/alert-dialog';

export const fullPermissionConfirmationCopy = {
  zh: {
    title: '开启完全权限？',
    description: '执行命令、读写文件和联网时，将不再逐项询问。',
    risks: ['文件可能被覆盖或删除', '敏感数据可能外泄，后果难以撤销'],
    cancel: '取消',
    confirm: '启用完全权限',
    failed: '未能完成权限确认，请重试。',
  },
  en: {
    title: 'Enable Full permission?',
    description:
      'Commands, file access and internet use will no longer require individual approval.',
    risks: [
      'Files may be overwritten or deleted',
      'Sensitive data may be exposed, with consequences that are hard to undo',
    ],
    cancel: 'Cancel',
    confirm: 'Enable Full',
    failed: 'Permission confirmation did not complete. Please try again.',
  },
} as const;

type ConfirmationProps = {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
  confirmDisabled?: boolean;
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>['onCloseAutoFocus'];
};

export type ApplicationConfirmationDialogProps = ConfirmationProps &
  (
    | { kind: 'full-permission'; language: 'zh' | 'en' }
    | { kind: 'workspace-removal'; label: string }
    | { kind: 'provider-removal'; label: string; modelCount: number }
    | { kind: 'skill-uninstall'; label: string }
  );

/** Fixed presentation only; the caller owns admission and all business actions. */
export function ApplicationConfirmationDialog(props: ApplicationConfirmationDialogProps) {
  const { open, onOpenChange, onConfirm, confirmDisabled, onCloseAutoFocus } = props;
  const text = confirmationCopy(props);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="full-permission-dialog" onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader className="full-permission-header">
          <AlertDialogTitle className="full-permission-title">
            <HugeiconsIcon
              className="full-permission-title-icon"
              icon={TriangleAlertIcon}
              aria-hidden="true"
            />
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{text.title}</span>
          </AlertDialogTitle>
          <AlertDialogDescription asChild className="full-permission-description">
            <div>
              <p className="full-permission-intro">{text.description}</p>
              {props.kind === 'full-permission' && (
                <ul className="full-permission-risks">
                  {fullPermissionConfirmationCopy[props.language].risks.map((risk) => (
                    <li key={risk}>{risk}</li>
                  ))}
                </ul>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="full-permission-footer">
          <AlertDialogCancel>{text.cancel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={confirmDisabled} onClick={onConfirm}>
            {text.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function confirmationCopy(props: ApplicationConfirmationDialogProps) {
  switch (props.kind) {
    case 'full-permission':
      return fullPermissionConfirmationCopy[props.language];
    case 'workspace-removal':
      return {
        title: `移除空间“${props.label}”？`,
        description:
          '将移除本地项目登记及全部会话列表，并请求停止运行中的任务。历史先保留；任务结束并过宽限期后，可在退出客户端后通过离线维护清理。未结束或结果未知的执行证据会继续保留。不会删除工作目录中的文件。',
        cancel: '保留空间',
        confirm: '移除空间',
      };
    case 'skill-uninstall':
      return {
        title: `卸载「${props.label}」？`,
        description: '该 Skill 及其配套文件将移到系统废纸篓。',
        cancel: '取消',
        confirm: '确认卸载',
      };
    case 'provider-removal':
      return {
        title: `删除「${props.label}」？`,
        description: props.modelCount
          ? `将删除此连接及 ${props.modelCount} 个关联模型的配置。`
          : '将删除此连接。',
        cancel: '取消',
        confirm: '确认删除提供商',
      };
  }
}

/** Shared Web fallback for the permission-specific scope owner in Composer. */
export function FullPermissionConfirmationDialog(
  props: ConfirmationProps & { language: 'zh' | 'en' },
) {
  return <ApplicationConfirmationDialog {...props} kind="full-permission" />;
}
