import { Entity } from '../EntityComponentSystem';
import { MotionComponent } from '../EntityComponentSystem/Components/MotionComponent';
import { TransformComponent } from '../EntityComponentSystem/Components/TransformComponent';
import { AddedEntity, isAddedSystemEntity, RemovedEntity, System, SystemType } from '../EntityComponentSystem/System';
import { CollisionEndEvent, CollisionStartEvent, ContactEndEvent, ContactStartEvent } from '../Events';
import { CollisionResolutionStrategy, Physics } from './Physics';
import { ArcadeSolver } from './Solver/ArcadeSolver';
import { Collider } from './Shapes/Collider';
import { CollisionContact } from './Detection/CollisionContact';
import { DynamicTreeCollisionProcessor } from './Detection/DynamicTreeCollisionProcessor';
import { RealisticSolver } from './Solver/RealisticSolver';
import { CollisionSolver } from './Solver/Solver';
import { ColliderComponent } from './ColliderComponent';
import { CompositeCollider } from './Shapes/CompositeCollider';
import { Engine, ExcaliburGraphicsContext, Scene } from '..';

export class CollisionSystem extends System<TransformComponent | MotionComponent | ColliderComponent> {
  public readonly types = ['ex.transform', 'ex.motion', 'ex.collider'] as const;
  public systemType = SystemType.Update;
  public priority = -1;

  private _engine: Engine;
  private _realisticSolver = new RealisticSolver();
  private _arcadeSolver = new ArcadeSolver();
  private _processor = new DynamicTreeCollisionProcessor();
  private _lastFrameContacts = new Map<string, CollisionContact>();
  private _currentFrameContacts = new Map<string, CollisionContact>();

  private _trackCollider = (c: Collider) => this._processor.track(c);
  private _untrackCollider = (c: Collider) => this._processor.untrack(c);

  notify(message: AddedEntity | RemovedEntity) {
    if (isAddedSystemEntity(message)) {
      const colliderComponent = message.data.get(ColliderComponent);
      colliderComponent.$colliderAdded.subscribe(this._trackCollider);
      colliderComponent.$colliderRemoved.subscribe(this._untrackCollider);
      const collider = colliderComponent.get();
      if (collider) {
        this._processor.track(collider);
      }
    } else {
      const colliderComponent = message.data.get(ColliderComponent);
      const collider = colliderComponent.get();
      if (colliderComponent) {
        this._processor.untrack(collider);
      }
    }
  }

  initialize(scene: Scene) {
    this._engine = scene.engine;
  }

  update(_entities: Entity[], elapsedMs: number): void {
    if (!Physics.enabled) {
      return;
    }

    // Collect up all the colliders
    let colliders: Collider[] = [];
    for (const entity of _entities) {
      const colliderComp = entity.get(ColliderComponent);
      const collider = colliderComp?.get();
      if (colliderComp && colliderComp.owner?.active) {
        colliderComp.update();
        if (collider instanceof CompositeCollider) {
          colliders = colliders.concat(collider.getColliders());
        } else {
          colliders.push(collider);
        }
      }
    }

    // Update the spatial partitioning data structures
    // TODO if collider invalid it will break the processor
    // TODO rename "update" to something more specific
    this._processor.update(colliders);

    // Run broadphase on all colliders and locates potential collisions
    const pairs = this._processor.broadphase(colliders, elapsedMs);

    this._currentFrameContacts.clear();

    // Given possible pairs find actual contacts
    let contacts = this._processor.narrowphase(pairs, this._engine.debug.stats.currFrame);

    const solver: CollisionSolver = this.getSolver();

    // Solve, this resolves the position/velocity so entities arent overlapping
    contacts = solver.solve(contacts);

    // Record contacts
    contacts.forEach((c) => this._currentFrameContacts.set(c.id, c));

    // Emit contact start/end events
    this.runContactStartEnd();

    // reset the last frame cache
    this._lastFrameContacts.clear();

    // Keep track of collisions contacts that have started or ended
    this._lastFrameContacts = new Map(this._currentFrameContacts);
  }

  getSolver(): CollisionSolver {
    return Physics.collisionResolutionStrategy === CollisionResolutionStrategy.Realistic ? this._realisticSolver : this._arcadeSolver;
  }

  debug(ex: ExcaliburGraphicsContext) {
    this._processor.debug(ex);
  }

  public runContactStartEnd() {
    for (const [id, c] of this._currentFrameContacts) {
      // find all new contacts
      if (!this._lastFrameContacts.has(id)) {
        const colliderA = c.colliderA;
        const colliderB = c.colliderB;
        colliderA.events.emit('collisionstart', new CollisionStartEvent(colliderA, colliderB, c));
        colliderA.events.emit('contactstart', new ContactStartEvent(colliderA, colliderB, c) as any);
        colliderB.events.emit('collisionstart', new CollisionStartEvent(colliderB, colliderA, c));
        colliderB.events.emit('contactstart', new ContactStartEvent(colliderB, colliderA, c) as any);
      }
    }

    // find all contacts taht have ceased
    for (const [id, c] of this._lastFrameContacts) {
      if (!this._currentFrameContacts.has(id)) {
        const colliderA = c.colliderA;
        const colliderB = c.colliderB;
        colliderA.events.emit('collisionend', new CollisionEndEvent(colliderA, colliderB));
        colliderA.events.emit('contactend', new ContactEndEvent(colliderA, colliderB) as any);
        colliderB.events.emit('collisionend', new CollisionEndEvent(colliderB, colliderA));
        colliderB.events.emit('contactend', new ContactEndEvent(colliderB, colliderA) as any);
      }
    }
  }
}