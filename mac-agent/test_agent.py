import asyncio
import unittest
from unittest.mock import AsyncMock, Mock, patch

import heranborsa_agent as agent


class ConnectionTests(unittest.IsolatedAsyncioTestCase):
    def client(self, connected=False):
        return Mock(is_connected=Mock(return_value=connected), connect=AsyncMock(),
                    disconnect=AsyncMock(), get_me=AsyncMock(return_value=object()))

    async def test_disconnected_client_reconnects_and_checks_session(self):
        client = self.client()
        await agent.ensure_telegram_connection(client)
        client.connect.assert_awaited_once()
        client.get_me.assert_awaited_once()

    async def test_connected_idle_client_does_not_poll_telegram(self):
        client = self.client(True)
        await agent.ensure_telegram_connection(client)
        client.get_me.assert_not_awaited()

    async def test_stale_connection_recovers_before_command(self):
        client = self.client()
        client.is_connected.side_effect = [True, True, False]
        client.get_me.side_effect = [ConnectionError('offline'), object()]
        with patch.object(agent.asyncio, 'sleep', new_callable=AsyncMock):
            await agent.ensure_telegram_connection(client, probe=True)
        client.disconnect.assert_awaited_once()
        client.connect.assert_awaited_once()
        self.assertEqual(client.get_me.await_count, 2)

    async def test_reconnect_attempts_are_bounded(self):
        client = self.client()
        client.connect.side_effect = OSError('offline')
        with patch.object(agent.asyncio, 'sleep', new_callable=AsyncMock):
            with self.assertRaisesRegex(ConnectionError, 'yeniden kurulamadı'):
                await agent.ensure_telegram_connection(client)
        self.assertEqual(client.connect.await_count, 3)

    async def test_invalid_session_is_not_accepted(self):
        client = self.client()
        client.get_me.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'oturumu geçersiz'):
            await agent.ensure_telegram_connection(client)

    async def test_offline_agent_does_not_claim_job(self):
        client = self.client()
        queue = Mock(claim=AsyncMock(), close=AsyncMock())
        with patch.object(agent, 'validate_environment'), patch.object(agent, 'load_telegram_config', return_value={}), \
             patch.object(agent, 'telegram_client', return_value=client), patch.object(agent, 'CloudQueue', return_value=queue), \
             patch.object(agent, 'ensure_telegram_connection', side_effect=ConnectionError('offline')), \
             patch.object(agent.asyncio, 'sleep', side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                await agent.main()
        queue.claim.assert_not_awaited()
        queue.close.assert_awaited_once()

    async def test_timeout_reports_step_without_replaying_command(self):
        queue = Mock(renew=AsyncMock(), complete=AsyncMock())
        payload = {'job': {'id': 'test', 'steps': [{'botUsername': 'b0pt_bot', 'command': '/kurum tera'}]}, 'leaseToken': 'lease'}
        with patch.object(agent, 'run_step', side_effect=asyncio.TimeoutError) as run:
            await agent.execute_job(self.client(), queue, payload)
        run.assert_awaited_once()
        error = queue.complete.call_args.args[3]
        self.assertIn('Adım 1/1', error)
        self.assertIn('zaman aşımına', error)


if __name__ == '__main__':
    unittest.main()
