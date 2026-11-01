import * as SecureStore from 'expo-secure-store';
import type { Pairing } from './relay/client.ts';

// The device token lives in the iOS Keychain, readable only while this device is unlocked.
const KEY = 'wotsrelay.pairing';

export async function loadPairing(): Promise<Pairing | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  return raw ? (JSON.parse(raw) as Pairing) : null;
}

export async function savePairing(p: Pairing): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(p), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}

export async function forgetPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
