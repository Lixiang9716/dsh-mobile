/**
 * Composer.tsx — the input deck: pill input + one gradient button that
 * morphs between 发送 (↑) and 停止 (■) on the fold's live running signal.
 * Submit clears the input by remounting it (key bump → fresh default-value;
 * the native input carries no controlled value).
 */
import { useState } from '@lynx-js/react';
import type { FC } from '@lynx-js/react';
import type { BaseEvent } from '@lynx-js/types';
import { styles } from '../styles.js';
import { emitIntent } from '../bridge.js';

interface InputDetail { value: string }

export const Composer: FC<{ running: boolean }> = ({ running }) => {
  const [text, setText] = useState('');
  const [generation, setGeneration] = useState(0);
  const canSend = text.trim() !== '' && !running;

  const send = (): void => {
    if (running) {
      emitIntent({ type: 'cancel' });
      return;
    }
    if (text.trim() === '') return;
    emitIntent({ type: 'submit', text: text.trim() });
    setText('');
    setGeneration(generation + 1);
  };

  return (
    <view style={styles.composer}>
      <view style={styles.composerCard}>
        <input
          key={generation}
          style={styles.input}
          placeholder='描述你想要构建的内容'
          confirm-type='send'
          default-value=''
          bindinput={(e: BaseEvent<'bindinput', InputDetail>) => setText(e.detail.value)}
        />
        <view
          style={{
            ...styles.sendBtn,
            ...(running ? styles.sendBtnStop : {}),
            ...(!canSend && !running ? styles.sendBtnDisabled : {}),
          }}
          bindtap={send}
        >
          <text style={styles.sendBtnText}>{running ? '■' : '↑'}</text>
        </view>
      </view>
    </view>
  );
};
