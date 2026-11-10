import {createClient} from '../supabase/server';
import {createReceptionPilotHandlers,type PilotConfig} from './reception-pilot';
/** Receives only validated server configuration from the runtime.
 * Uses the existing cookie session, never a service-role credential. */
export function configuredReceptionPilot(config:Readonly<PilotConfig>){
 return createReceptionPilotHandlers({config,session:createClient});
}
