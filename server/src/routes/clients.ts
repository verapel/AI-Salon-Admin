import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { clients } from '../data/store.js';
import type { Client } from '../types.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(clients);
});

router.get('/:id', (req, res) => {
  const client = clients.find((c) => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

router.post('/', (req, res) => {
  const { name, email, phone, notes } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

  const client: Client = {
    id: uuidv4(),
    name,
    email,
    phone: phone || '',
    notes: notes || '',
    totalVisits: 0,
    lastVisit: null,
    createdAt: new Date().toISOString().split('T')[0],
  };
  clients.push(client);
  res.status(201).json(client);
});

router.put('/:id', (req, res) => {
  const index = clients.findIndex((c) => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Client not found' });

  clients[index] = { ...clients[index], ...req.body, id: clients[index].id };
  res.json(clients[index]);
});

router.delete('/:id', (req, res) => {
  const index = clients.findIndex((c) => c.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Client not found' });
  clients.splice(index, 1);
  res.status(204).send();
});

export default router;
