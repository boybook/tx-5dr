import React, { useState } from 'react';
import { ColorPicker, useColor, type IColor } from 'react-color-palette';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
} from '@heroui/react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPalette } from '@fortawesome/free-solid-svg-icons';
import 'react-color-palette/css';

interface InteractiveColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  disabled?: boolean;
}

export const InteractiveColorPicker: React.FC<InteractiveColorPickerProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const [color, setColor] = useColor(value);
  const [isOpen, setIsOpen] = useState(false);

  const handleColorChange = (newColor: IColor) => {
    setColor(newColor);
    onChange(newColor.hex);
  };

  return (
    <Popover 
      isOpen={isOpen} 
      onOpenChange={setIsOpen}
      placement="bottom-start"
      className="min-w-0"
    >
      <PopoverTrigger>
        <Button
          variant="flat"
          isDisabled={disabled}
          className="h-8 px-3 bg-default-100 hover:bg-default-200"
          startContent={
            <div
              className="w-4 h-4 rounded border border-default-300"
              style={{ backgroundColor: value }}
            />
          }
          endContent={
            <FontAwesomeIcon icon={faPalette} className="text-default-500 text-xs" />
          }
        >
          <span className="text-xs text-default-700">选择颜色</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-4">
        <div className="flex flex-col gap-3">
          <div className="text-sm font-medium text-default-900">
            选择颜色
          </div>
          <div
            className="react-color-palette-container"
            style={{
              '--rcp-bg': 'white',
              '--rcp-border': '#e4e4e7',
              '--rcp-input-border': '#d4d4d8',
              '--rcp-input-label': '#71717a',
            } as React.CSSProperties}
          >
            <ColorPicker
              color={color}
              onChange={handleColorChange}
              height={160}
              hideInput={['rgb', 'hsv']} // 只显示HEX输入
            />
          </div>
          <div className="flex justify-between items-center">
            <div className="text-xs text-default-500">
              当前颜色: {value}
            </div>
            <Button
              size="sm"
              color="primary"
              onPress={() => setIsOpen(false)}
            >
              确定
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}; 