import React from 'react';
import { Button, ButtonGroup, Input, Modal, ModalBody, ModalContent, Popover, PopoverContent, PopoverTrigger, Slider } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faAlignCenter, faAlignLeft, faAlignRight, faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { ImageTemplateTextLayer } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { InteractiveColorPicker } from '../settings/InteractiveColorPicker';
import { normalizeLayerRotation, resizeTextLayerFont, rotateTextLayer } from './sstvTextLayerGeometry';

export function SstvTextLayerInspector({
  layer,
  placement,
  isOpen,
  onOpenChange,
  shouldCloseOnInteractOutside,
  canvasWidth,
  canvasHeight,
  onChange,
  onDelete,
}: {
  layer: ImageTemplateTextLayer;
  placement: 'side' | 'bottom';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  shouldCloseOnInteractOutside?: (element: Element) => boolean;
  canvasWidth: number;
  canvasHeight: number;
  onChange: (layer: ImageTemplateTextLayer) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('image');
  const content = (
    <div className="grid w-full min-w-0 items-center gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 9rem), 1fr))' }}>
      <Input size="sm" label={t('layerText')} value={layer.text} onValueChange={(text) => onChange({ ...layer, text })} />
      <InteractiveColorPicker
        value={layer.color}
        onChange={(color) => onChange({ ...layer, color })}
        label={t('fillColor')}
        buttonClassName="w-full min-w-0 justify-between"
        hideAlpha
      />
      <InteractiveColorPicker
        value={layer.strokeColor ?? '#000000'}
        onChange={(strokeColor) => onChange({ ...layer, strokeColor })}
        label={t('strokeColor')}
        buttonClassName="w-full min-w-0 justify-between"
        hideAlpha
      />
      <Slider
        size="sm" minValue={0.02} maxValue={0.5} step={0.01} value={layer.fontSize}
        onChange={(value) => onChange(resizeTextLayerFont(layer, Number(value), canvasWidth, canvasHeight))}
        label={t('textSize')}
      />
      <Slider
        size="sm" minValue={0} maxValue={0.5} step={0.01} value={layer.strokeWidth ?? 0.12}
        onChange={(value) => onChange({ ...layer, strokeWidth: Number(value) })}
        label={t('strokeWidth')}
      />
      <Slider
        size="sm" minValue={-180} maxValue={180} step={1} value={layer.rotation ?? 0}
        onChange={(value) => onChange(rotateTextLayer(layer, normalizeLayerRotation(Number(value)), canvasWidth, canvasHeight))}
        label={<span className="flex min-w-0 items-center gap-1.5"><FontAwesomeIcon icon={faRotateRight} /><span className="shrink-0">{Math.round(layer.rotation ?? 0)}°</span></span>}
        aria-label="Rotation"
      />
      <div className="flex min-w-0 items-center justify-between gap-2">
        <ButtonGroup size="sm" variant="flat" aria-label="Text alignment">
          {([
            ['left', faAlignLeft],
            ['center', faAlignCenter],
            ['right', faAlignRight],
          ] as const).map(([align, icon]) => (
            <Button
              key={align}
              isIconOnly
              color={layer.align === align ? 'primary' : 'default'}
              onPress={() => onChange({ ...layer, align })}
              aria-label={align === 'left' ? 'Align left' : align === 'right' ? 'Align right' : 'Align center'}
              title={align === 'left' ? 'Align left' : align === 'right' ? 'Align right' : 'Align center'}
            >
              <FontAwesomeIcon icon={icon} />
            </Button>
          ))}
        </ButtonGroup>
        <Button isIconOnly size="sm" variant="light" color="danger" onPress={onDelete} aria-label={t('deleteText')} title={t('deleteText')}>
          <FontAwesomeIcon icon={faTrash} />
        </Button>
      </div>
    </div>
  );
  if (placement === 'side') {
    return (
      <Popover isOpen={isOpen} onOpenChange={onOpenChange} shouldCloseOnInteractOutside={shouldCloseOnInteractOutside} placement="left" offset={10} showArrow>
        <PopoverTrigger>
          <span className="pointer-events-none absolute left-0 top-1/2 h-px w-px" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent className="min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden p-2.5 w-52">{content}</PopoverContent>
      </Popover>
    );
  }
  return (
    <Modal
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      placement="bottom"
      size="lg"
      classNames={{ base: 'm-0 w-full max-w-none rounded-b-none', body: 'max-h-[70dvh] overflow-y-auto p-3' }}
    >
      <ModalContent><ModalBody>{content}</ModalBody></ModalContent>
    </Modal>
  );
}
