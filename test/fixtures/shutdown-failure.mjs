import { appendFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const close = StdioServerTransport.prototype.close;
StdioServerTransport.prototype.close = async function () {
  await close.call(this);
  await appendFile(process.env.SMIP_SHUTDOWN_PROOF, 'transportJoined\n');
  throw new Error('synthetic transport close failure');
};
process.on('unhandledRejection', async () => {
  await appendFile(process.env.SMIP_SHUTDOWN_PROOF, 'unhandledRejection\n');
});
