import React from 'react';
import { Button, ButtonGroup, Modal, ModalBody, ModalContent, Popover, PopoverContent, PopoverTrigger, Slider } from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faRotateRight, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { ImageComposerTransform } from '@tx5dr/contracts';
import { useTranslation } from 'react-i18next';

import { normalizeLayerRotation } from './sstvTextLayerGeometry';

type EditableImageTransform = Pick<ImageComposerTransform, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'fit' | 'crop' | 'flipX' | 'flipY'>;

export function SstvImageLayerInspector({
  transform,
  placement,
  isOpen,
  onOpenChange,
  shouldCloseOnInteractOutside,
  onChange,
  onFit,
  cropZoom,
  isCropping,
  onCropZoom,
  onToggleCrop,
  onFlipX,
  onFlipY,
  onDelete,
}: {
  transform: EditableImageTransform;
  placement: 'side' | 'bottom';
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  shouldCloseOnInteractOutside?: (element: Element) => boolean;
  onChange: (transform: EditableImageTransform) => void;
  onFit: (fit: EditableImageTransform['fit']) => void;
  cropZoom: number;
  isCropping: boolean;
  onCropZoom: (zoom: number) => void;
  onToggleCrop: () => void;
  onFlipX: () => void;
  onFlipY: () => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation('image');
  const content = (
    <div className="grid w-full min-w-0 gap-2">
      <ButtonGroup size="sm" variant="flat" className="w-full min-w-0">
        <Button className="min-w-0 flex-1 px-1" color={transform.fit === 'cover' ? 'primary' : 'default'} onPress={() => onFit('cover')}><span className="truncate">{t('fill')}</span></Button>
        <Button className="min-w-0 flex-1 px-1" color={transform.fit === 'contain' ? 'primary' : 'default'} onPress={() => onFit('contain')}><span className="truncate">{t('fit')}</span></Button>
      </ButtonGroup>
      <div className="grid min-w-0 grid-cols-3 gap-2">
        <Button size="sm" className="min-w-0 px-1 text-xs" color={isCropping ? 'primary' : 'default'} onPress={onToggleCrop}><span className="truncate">{t('crop')}</span></Button>
        <Button size="sm" className="min-w-0 px-1 text-xs" onPress={onFlipX}><span className="truncate">{t('flipHorizontal')}</span></Button>
        <Button size="sm" className="min-w-0 px-1 text-xs" onPress={onFlipY}><span className="truncate">{t('flipVertical')}</span></Button>
      </div>
      {isCropping ? (
        <Slider size="sm" minValue={1} maxValue={4} step={0.1} value={cropZoom} onChange={(value) => onCropZoom(Number(value))} label={t('cropZoom')} />
      ) : null}
      <Slider
        size="sm"
        minValue={-180}
        maxValue={180}
        step={1}
        value={transform.rotation}
        onChange={(value) => onChange({ ...transform, rotation: normalizeLayerRotation(Number(value)) })}
        label={<span className="flex min-w-0 items-center gap-1.5"><FontAwesomeIcon icon={faRotateRight} /><span className="shrink-0">{Math.round(transform.rotation)}°</span></span>}
        aria-label={t('rotation')}
      />
      {onDelete ? (
        <div className="flex justify-end">
          <Button isIconOnly size="sm" variant="light" color="danger" onPress={onDelete} aria-label={t('deleteImage')} title={t('deleteImage')}>
            <FontAwesomeIcon icon={faTrash} />
          </Button>
        </div>
      ) : null}
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
      classNames={{ base: 'm-0 w-full max-w-none rounded-b-none', body: 'max-h-[60dvh] overflow-y-auto p-3' }}
    >
      <ModalContent><ModalBody>{content}</ModalBody></ModalContent>
    </Modal>
  );
}
