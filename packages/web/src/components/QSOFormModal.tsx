import React, { useEffect, useState } from 'react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Textarea,
  Select,
  SelectItem,
  Checkbox,
  Alert,
} from '@heroui/react';
import type { QSORecord } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

const MODES = ['FT8', 'FT4', 'SSB', 'CW', 'AM', 'FM', 'RTTY', 'PSK31', 'JS8', 'MSK144'];

export interface QSOFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Modal 标题，由父组件控制 */
  title: string;
  /** 当前表单数据，父组件持有 */
  formData: Partial<QSORecord>;
  /** 字段变更时回调，父组件更新状态 */
  onChange: (data: Partial<QSORecord>) => void;
  onSave: () => void;
  isSaving: boolean;
  /**
   * 'edit'（默认）：显示全部字段，含操作警告
   * 'add'：显示全部字段，隐藏操作警告
   */
  mode?: 'edit' | 'add';
}

/**
 * 通用 QSO 表单弹窗，编辑和补录场景共用同一套字段渲染。
 * 唯一区别：add 模式隐藏操作警告提示。
 */
const QSOFormModal: React.FC<QSOFormModalProps> = ({
  isOpen,
  onClose,
  title,
  formData,
  onChange,
  onSave,
  isSaving,
  mode = 'edit',
}) => {
  const { t } = useTranslation('logbook');
  const isAdd = mode === 'add';

  // 频率以 MHz 展示（内部状态，避免受控输入的小数精度丢失问题）
  const [freqMHz, setFreqMHz] = useState('');
  // 通联时间的 datetime-local 字符串（UTC）
  const [startTimeLocal, setStartTimeLocal] = useState('');

  // Modal 打开时从 formData 初始化内部展示状态
  useEffect(() => {
    if (!isOpen) return;
    setFreqMHz(formData.frequency ? String(formData.frequency / 1e6) : isAdd ? '14.074' : '');
    setStartTimeLocal(
      formData.startTime
        ? new Date(formData.startTime).toISOString().slice(0, 16)
        : isAdd
          ? new Date().toISOString().slice(0, 16)
          : '',
    );
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFreqChange = (val: string) => {
    setFreqMHz(val);
    const hz = parseFloat(val) * 1e6;
    if (!isNaN(hz)) onChange({ ...formData, frequency: hz });
  };

  const handleStartTimeChange = (val: string) => {
    setStartTimeLocal(val);
    onChange({ ...formData, startTime: val ? new Date(val + 'Z').getTime() : undefined });
  };

  const isSaveDisabled = isAdd
    ? !formData.callsign?.trim() || !formData.frequency || !formData.mode || !formData.startTime
    : !formData.callsign || !formData.frequency;

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" scrollBehavior="inside">
      <ModalContent>
        <ModalHeader>
          <h3 className="text-lg font-semibold">{title}</h3>
        </ModalHeader>

        <ModalBody>
          <div className="space-y-4">
            {/* 通联时间（全行） */}
            <Input
              label={t('addQso.startTime')}
              type="datetime-local"
              value={startTimeLocal}
              onChange={e => handleStartTimeChange(e.target.value)}
              isRequired={isAdd}
            />

            {/* 呼号 + 网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('editQso.callsign')}
                value={formData.callsign || ''}
                onChange={e => onChange({ ...formData, callsign: e.target.value })}
                isRequired
              />
              <Input
                label={t('editQso.grid')}
                value={formData.grid || ''}
                onChange={e => onChange({ ...formData, grid: e.target.value || undefined })}
              />
            </div>

            {/* 我的呼号 + 我的网格 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('editQso.myCallsign')}
                value={formData.myCallsign || ''}
                onChange={e => onChange({ ...formData, myCallsign: e.target.value })}
              />
              <Input
                label={t('editQso.myGrid')}
                value={formData.myGrid || ''}
                onChange={e => onChange({ ...formData, myGrid: e.target.value })}
              />
            </div>

            {/* 频率(MHz) + 模式 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('addQso.frequency')}
                type="number"
                step="0.001"
                placeholder={t('addQso.frequencyPlaceholder')}
                value={freqMHz}
                onChange={e => handleFreqChange(e.target.value)}
                isRequired
              />
              <Select
                label={t('editQso.mode')}
                selectedKeys={formData.mode ? [formData.mode] : []}
                onSelectionChange={keys => {
                  const selected = Array.from(keys as Set<string>)[0];
                  if (selected) onChange({ ...formData, mode: selected });
                }}
                isRequired
              >
                {MODES.map(m => (
                  <SelectItem key={m}>{m}</SelectItem>
                ))}
              </Select>
            </div>

            {/* 信号报告 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label={t('editQso.reportSent')}
                value={formData.reportSent || ''}
                onChange={e => onChange({ ...formData, reportSent: e.target.value || undefined })}
              />
              <Input
                label={t('editQso.reportReceived')}
                value={formData.reportReceived || ''}
                onChange={e => onChange({ ...formData, reportReceived: e.target.value || undefined })}
              />
            </div>

            {/* 备注（全行） */}
            <Textarea
              label={t('editQso.remarks')}
              value={formData.remarks || ''}
              onChange={e => onChange({ ...formData, remarks: e.target.value || undefined })}
              minRows={2}
            />

            {/* QSL 确认状态（两种模式均显示） */}
            <div className="border-t border-default-200 dark:border-default-100 pt-4">
              <p className="text-sm font-medium text-default-500 mb-3">
                {t('editQso.confirmStatus')}
              </p>
              <div className="grid grid-cols-2 gap-4">
                {/* LoTW */}
                <div className="flex items-center justify-between rounded-lg bg-default-50 dark:bg-default-100/5 px-3.5 py-2.5">
                  <span className="text-sm font-medium text-default-600">LoTW</span>
                  <div className="flex items-center gap-4">
                    <Checkbox
                      size="sm"
                      isSelected={formData.lotwQslSent === 'Y'}
                      onValueChange={checked =>
                        onChange({ ...formData, lotwQslSent: checked ? 'Y' : 'N' })
                      }
                      color="primary"
                    >
                      <span className="text-sm">{t('editQso.uploaded')}</span>
                    </Checkbox>
                    <Checkbox
                      size="sm"
                      isSelected={
                        formData.lotwQslReceived === 'Y' || formData.lotwQslReceived === 'V'
                      }
                      onValueChange={checked =>
                        onChange({ ...formData, lotwQslReceived: checked ? 'Y' : 'N' })
                      }
                      color="success"
                    >
                      <span className="text-sm">{t('editQso.confirmed')}</span>
                    </Checkbox>
                  </div>
                </div>
                {/* QRZ */}
                <div className="flex items-center justify-between rounded-lg bg-default-50 dark:bg-default-100/5 px-3.5 py-2.5">
                  <span className="text-sm font-medium text-default-600">QRZ</span>
                  <div className="flex items-center gap-4">
                    <Checkbox
                      size="sm"
                      isSelected={formData.qrzQslSent === 'Y'}
                      onValueChange={checked =>
                        onChange({ ...formData, qrzQslSent: checked ? 'Y' : 'N' })
                      }
                      color="primary"
                    >
                      <span className="text-sm">{t('editQso.uploaded')}</span>
                    </Checkbox>
                    <Checkbox
                      size="sm"
                      isSelected={formData.qrzQslReceived === 'Y'}
                      onValueChange={checked =>
                        onChange({ ...formData, qrzQslReceived: checked ? 'Y' : 'N' })
                      }
                      color="success"
                    >
                      <span className="text-sm">{t('editQso.confirmed')}</span>
                    </Checkbox>
                  </div>
                </div>
              </div>
            </div>

            {/* edit 独有：操作警告 */}
            {!isAdd && (
              <Alert color="warning" variant="flat" className="text-sm">
                {t('editQso.editWarning')}
              </Alert>
            )}
          </div>
        </ModalBody>

        <ModalFooter>
          <Button variant="flat" onPress={onClose}>
            {t('common:button.cancel')}
          </Button>
          <Button
            color="primary"
            onPress={onSave}
            isLoading={isSaving}
            isDisabled={isSaveDisabled}
          >
            {t('common:button.save')}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
};

export default QSOFormModal;
