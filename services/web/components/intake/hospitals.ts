export interface Hospital {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export const HOSPITALS: Hospital[] = [
  { id: 'nimhans',    name: 'NIMHANS',                         lat: 12.9392, lng: 77.5956 },
  { id: 'manipal',   name: 'Manipal Hospital (Airport Road)', lat: 12.9592, lng: 77.6474 },
  { id: 'fortis',    name: 'Fortis Hospital (Bannerghatta)',  lat: 12.8935, lng: 77.5983 },
  { id: 'bgsh',      name: 'BGS Gleneagles Global Hospital',  lat: 12.9100, lng: 77.5500 },
  { id: 'columbia',  name: 'Columbia Asia Hospital (Hebbal)', lat: 13.0358, lng: 77.5970 },
  { id: 'apollo',    name: 'Apollo Hospital (Bannerghatta)',  lat: 12.8927, lng: 77.6021 },
];
