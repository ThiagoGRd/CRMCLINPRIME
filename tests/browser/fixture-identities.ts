// Valid, deterministic synthetic identities, shared by the HTTP server and UI fixture.
export const fixtureId = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const fixtureIds = {
  org: fixtureId(1), user: fixtureId(11), member: fixtureId(12),
  patient: fixtureId(101), newPatient: fixtureId(102),
  reception: fixtureId(201), commercial: fixtureId(202), crc: fixtureId(203),
  receptionConversation: fixtureId(301), commercialConversation: fixtureId(302), crcConversation: fixtureId(303),
};
