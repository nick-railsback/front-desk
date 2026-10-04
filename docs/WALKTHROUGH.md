# Walkthrough script

Nick's own words, written at each review gate before committing, three lines per chunk. By Monday this is the interview script. Agents don't write this file.

## 01 baseline
- What:
- Why:
- Where:

## 02 infra
- What:
- Why:
- Where:

## 03 contract-and-seed
- What:
- Why:
- Where:

## 04 eval-harness
- What:
- Why:
- Where:

## 05 pipeline
- What:
- Why:
- Where:

## 06 parent-ui
- What:
- Why:
- Where:

## 07 operator-ui
- What:
- Why:
- Where:

## 08 demo-hardening
- What:
- Why:
- Where:

## 08.5 demo-explainers
- What:
- Why:
- Where:

## 09 writeup
- What:
- Why:
- Where:

## Answer these cold (Monday explain-back)

- Why one model call, and what would make you add a second?
- Why no retrieval or vector search?
- What happens when Bedrock is down or slow?
- Walk me through how a wrong fee gets caught before a parent sees it.
- What does the model decide, and what does code decide?
- How do you know the eval numbers mean anything? What don't they tell you?
- Why one EC2 box? What changes for production on the platform?
- What changes at 10,000 centers?
- How would you measure this in a beta with real centers?
- Where are the secrets? (Trick question.)
- What did you deliberately not build, and why?
