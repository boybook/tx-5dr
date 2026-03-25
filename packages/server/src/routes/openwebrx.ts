import { FastifyInstance } from 'fastify';
import { OpenWebRXStationManager } from '../openwebrx/OpenWebRXStationManager.js';
import { OpenWebRXStationConfigSchema, OpenWebRXListenStartSchema, OpenWebRXListenTuneSchema } from '@tx5dr/contracts';
import { RadioError, RadioErrorCode } from '../utils/errors/RadioError.js';

/**
 * OpenWebRX SDR station management API routes
 */
export async function openwebrxRoutes(fastify: FastifyInstance) {
  const stationManager = OpenWebRXStationManager.getInstance();

  // Get all stations
  fastify.get('/stations', async (_request, reply) => {
    const stations = stationManager.getStations();
    return reply.code(200).send({ stations });
  });

  // Add a station
  fastify.post<{ Body: { name: string; url: string; description?: string } }>('/stations', async (request, reply) => {
    try {
      const { name, url, description } = request.body;
      if (!name || !url) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Missing required fields: name, url',
          userMessage: 'Station name and URL are required',
          suggestions: ['Provide both name and URL'],
        });
      }
      const station = await stationManager.addStation({ name, url, description });
      return reply.code(201).send({ success: true, station });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // Update a station
  fastify.put<{ Params: { id: string }; Body: { name?: string; url?: string; description?: string } }>('/stations/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await stationManager.updateStation(id, request.body);
      return reply.code(200).send({ success: true });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // Delete a station
  fastify.delete<{ Params: { id: string } }>('/stations/:id', async (request, reply) => {
    try {
      const { id } = request.params;
      await stationManager.removeStation(id);
      return reply.code(200).send({ success: true });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_CONFIG);
    }
  });

  // Test connection to a URL
  fastify.post<{ Body: { url: string } }>('/test-url', async (request, reply) => {
    try {
      const { url } = request.body;
      if (!url) {
        throw new RadioError({
          code: RadioErrorCode.INVALID_CONFIG,
          message: 'Missing required field: url',
          userMessage: 'URL is required for connection test',
          suggestions: ['Provide a valid WebSocket URL'],
        });
      }
      const result = await stationManager.testConnection(url);
      return reply.code(200).send(result);
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
    }
  });

  // Start listen session
  fastify.post<{ Body: { stationId: string; profileId?: string; frequency?: number; modulation?: string } }>('/listen/start', async (request, reply) => {
    try {
      const status = await stationManager.startListen(request.body);
      return reply.code(200).send({ success: true, status });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.CONNECTION_FAILED);
    }
  });

  // Stop listen session
  fastify.post('/listen/stop', async (_request, reply) => {
    try {
      await stationManager.stopListen();
      return reply.code(200).send({ success: true });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // Tune listen session
  fastify.post<{ Body: { profileId?: string; frequency?: number; modulation?: string; bandpassLow?: number; bandpassHigh?: number } }>('/listen/tune', async (request, reply) => {
    try {
      await stationManager.tuneListen(request.body);
      return reply.code(200).send({ success: true });
    } catch (error) {
      throw RadioError.from(error, RadioErrorCode.INVALID_OPERATION);
    }
  });

  // Get listen status
  fastify.get('/listen/status', async (_request, reply) => {
    const status = stationManager.getListenStatus();
    return reply.code(200).send({ status });
  });
}
