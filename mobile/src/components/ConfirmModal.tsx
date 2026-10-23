// Confirmação do próprio app (no lugar do Alert nativo): cartão pastel no
// meio da tela, com rolagem para textos longos (ex.: prévia do e-mail a enviar).
import { Modal, Pressable, ScrollView, View } from 'react-native';

import { useTheme } from '../theme';
import { Btn, T } from './ui';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** ação definitiva (ex.: enviar): botão de confirmar em destaque de alerta */
  destructive?: boolean;
  onConfirm: () => void;
}

export function ConfirmModal({ request, onClose }: { request: ConfirmRequest | null; onClose: () => void }) {
  const t = useTheme();
  const confirm = () => {
    const run = request?.onConfirm;
    onClose();
    run?.();
  };
  return (
    <Modal visible={!!request} transparent animationType="fade" onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Pressable
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(45,43,58,0.32)' }}
          onPress={onClose}
          accessibilityLabel="Cancelar"
        />
        {request ? (
          <View
            accessibilityViewIsModal
            style={{ backgroundColor: t.card, borderRadius: 20, padding: 20, width: '100%', maxWidth: 480, maxHeight: '85%' }}
          >
            <T title style={{ fontSize: 18, fontWeight: '600', marginBottom: 10 }}>{request.title}</T>
            <ScrollView style={{ flexGrow: 0 }}>
              <T style={{ fontSize: 14.5, lineHeight: 21 }}>{request.message}</T>
            </ScrollView>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
              <Btn label={request.cancelLabel || 'Cancelar'} onPress={onClose} style={{ flex: 1 }} />
              <Btn
                primary
                label={request.confirmLabel}
                onPress={confirm}
                style={[{ flex: 1 }, request.destructive ? { backgroundColor: '#c5221f', borderColor: '#c5221f' } : null]}
              />
            </View>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}
