// The center's details, programs, and registration fee, as PRD Appendix A
// states them.

import type { Center, Program } from './index';

export const center: Center = {
  name: 'Juniper Hill Early Learning Center',
  city: 'Cedar Mesa, New Mexico',
  timezone: 'America/Denver',
  phone: '(505) 555-0142',
  email: 'frontdesk@juniperhill.example',
  director: 'Dana Whitfield',
  officeHours: 'Monday to Friday, 7:00 AM to 5:30 PM',
};

export const programs: Program[] = [
  {
    id: 'infant-toddler',
    name: 'Infants & Toddlers',
    ages: '6 weeks to 3 years',
    hours: 'Monday to Friday, 7:30 AM to 5:30 PM',
    weeklyTuition: '$385',
  },
  {
    id: 'preschool',
    name: 'Preschool',
    ages: '3 to 5 years',
    hours: 'Monday to Friday, 7:00 AM to 5:30 PM',
    weeklyTuition: '$295',
  },
  {
    id: 'prek',
    name: 'Pre-K',
    ages: '4 years old by September 1',
    hours: 'Monday to Friday, core day 8:00 AM to 2:30 PM; extended care 2:30 PM to 5:30 PM',
    weeklyTuition: 'Core day state-funded, no tuition; extended care $95',
  },
];

export const registrationFee = '$75 per child per year';
