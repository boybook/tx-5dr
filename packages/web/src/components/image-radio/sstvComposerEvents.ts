export const SSTV_COMPOSER_INSERT_IMAGE_EVENT = 'tx5dr:sstv-composer-insert-image';

export type SstvComposerInsertImageDetail = {
  artifactId: string;
  mode?: string;
  callsign?: string;
  reply?: boolean;
};
