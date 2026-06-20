import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { services } from '../data/store.js';
import type { Service } from '../types.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(services);
});

router.get('/:id', (req, res) => {
  const service = services.find((s) => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  res.json(service);
});

router.post('/', (req, res) => {
  const { name, description, duration, price, category } = req.body;
  if (!name || !duration || !price) {
    return res.status(400).json({ error: 'Name, duration, and price are required' });
  }

  const service: Service = {
    id: uuidv4(),
    name,
    description: description || '',
    duration: Number(duration),
    price: Number(price),
    category: category || 'General',
    active: true,
  };
  services.push(service);
  res.status(201).json(service);
});

router.put('/:id', (req, res) => {
  const index = services.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Service not found' });

  services[index] = { ...services[index], ...req.body, id: services[index].id };
  res.json(services[index]);
});

router.delete('/:id', (req, res) => {
  const index = services.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Service not found' });
  services[index].active = false;
  res.json(services[index]);
});

export default router;
