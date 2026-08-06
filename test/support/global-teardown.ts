import { stopStack } from './containers';

export default async function globalTeardown(): Promise<void> {
  await stopStack();
}
